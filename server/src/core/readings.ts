import { createHash, randomBytes } from "node:crypto";
import { recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { PROOF_DOMAIN, READING_TYPES, type User } from "../auth/auth.js";
import type { Db } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import type { PlantService } from "../plant/plant.js";
import type { Recorder } from "./recorder.js";
import { FIELD, readingCommitment, stageSubject, ZERO_ROOT } from "./stage-proofs.js";

/** How far a gateway's clock and its signed requests may drift from Ordo's */
const SKEW_S = 120;
/** Stages a gateway is shown: still running, or finished in the last day and not signed yet */
const RECENT_MS = 86_400_000;

/** The OrdoReading a gateway or operator signs (EIP-712, PROOF_DOMAIN). Counts stay off it: only their commitment. */
export interface ReadingMessage {
  site: string;
  runId: string;
  stage: string;
  asset: string;
  commitment: bigint;
  anchor: Hex;
  signedAt: bigint;
}
/** What a signer submits: the message's fields, the counts and salt it committed to (kept private by Ordo), and the signature. */
export interface ReadingSubmission {
  runId: string;
  stage: string;
  good: number;
  scrap: number;
  salt: string;
  commitment: string;
  anchor: Hex;
  signedAt: number;
  signature: Hex;
}
/** A stage a gateway can sign: the window its counts must cover, and what the signature binds. */
export interface EdgeStage {
  site: string;
  runId: string;
  stage: string;
  asset: string;
  state: string;
  /** unix seconds */
  startedAt: number;
  /** unix seconds; null while the stage is still running */
  endedAt: number | null;
  subject: string;
  /** the newest HCS ledger anchor: sign it, so the reading cannot be older */
  anchor: Hex;
  signed: boolean;
}

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const anchorHex = (h: string) => `0x${h.replace(/^sha256:/, "").replace(/^0x/, "")}` as Hex;

/**
 * Signed stage readings: the source of a stage's counts signs them where they were made.
 *
 * A machine with a gateway (data source `gateway`) pushes its observations and, when a stage on it finishes, signs an
 * OrdoReading over a Poseidon commitment to the good and scrap units it counted and the stage's window. A manual stage's
 * operator signs one in the console. Ordo checks the signer, the commitment and the anchor, keeps the counts private,
 * and flags a reading whose counts differ from the ones Ordo recorded. StageProofs then proves the criteria from it.
 *
 * Gateways authenticate each request with their own key: `x-ordo-device`, `x-ordo-ts` and `x-ordo-sig`, an EIP-191
 * signature over `ordo-edge:<ts>:<METHOD>:<path>:<sha256 of the body>`.
 */
export class Readings {
  private seen = new Map<string, number>();

  constructor(
    private db: Db,
    private engine: RunEngine,
    private plant: PlantService,
    private rec: Recorder,
    private now: () => number,
  ) {}

  // ---------------------------------------------------------------- gateway requests
  /** The gateway that signed this request. */
  async device(h: { device?: string; ts?: string; sig?: string }, method: string, path: string, body: string): Promise<Address> {
    if (!h.device || !h.ts || !h.sig || !/^0x[0-9a-fA-F]{40}$/.test(h.device)) throw new HttpError(401, "Sign the request with the gateway's key (x-ordo-device, x-ordo-ts, x-ordo-sig)");
    const ts = Number(h.ts);
    if (!Number.isFinite(ts) || Math.abs(ts - this.now() / 1000) > SKEW_S) throw new HttpError(401, "The request's timestamp is too far from Ordo's clock");
    const message = edgeMessage(ts, method, path, body);
    const signer = await recoverMessageAddress({ message, signature: h.sig as Hex }).catch(() => null);
    if (signer?.toLowerCase() !== h.device.toLowerCase()) throw new HttpError(401, "The request's signature is not the gateway's");
    // each signed request is used once
    for (const [k, at] of this.seen) if (this.now() - at > SKEW_S * 2000) this.seen.delete(k);
    if (this.seen.has(h.sig)) throw new HttpError(401, "This request was already used");
    this.seen.set(h.sig, this.now());
    return signer.toLowerCase() as Address;
  }

  /** The assets whose data source is this gateway. */
  private async assetsOf(device: Address) {
    const r = await this.db.query<{ id: string; site_id: string; source_json: string }>("SELECT id, site_id, source_json FROM assets WHERE archived_at IS NULL");
    const mine = r.rows.filter((a) => {
      const s = JSON.parse(a.source_json) as { type: string; device?: string };
      return s.type === "gateway" && s.device?.toLowerCase() === device;
    });
    if (!mine.length) throw new HttpError(403, "No asset uses this gateway as its data source");
    return mine;
  }

  async observations(device: Address, assetId: string, rows: { signal: string; ts: string; value: number | null; text: string | null }[]) {
    const a = (await this.assetsOf(device)).find((x) => x.id === assetId);
    if (!a) throw new HttpError(403, "This gateway is not the data source of that asset");
    return { inserted: await this.plant.gatewayObservations(assetId, rows) };
  }

  /** The stages on this gateway's machines it can sign, newest first. */
  async edgeStages(device: Address): Promise<EdgeStage[]> {
    const assets = await this.assetsOf(device);
    const anchor = await this.latestAnchor();
    const out: EdgeStage[] = [];
    for (const a of assets) {
      const rows = await this.db.query<{ run_id: string; code: string }>(
        "SELECT s.run_id, s.code FROM stage_runs s WHERE s.asset_id = $1 AND s.started_at IS NOT NULL AND (s.state = 'running' OR s.started_at > $2) ORDER BY s.started_at DESC LIMIT 20",
        [a.id, new Date(this.now() - RECENT_MS).toISOString()],
      );
      for (const r of rows.rows) {
        const st = (await this.engine.view(a.site_id, r.run_id)).stages.find((s) => s.code === r.code);
        if (!st?.startedAt || st.assetId !== a.id) continue;
        const signed = (await this.db.query("SELECT 1 FROM stage_readings WHERE run_id = $1 AND stage_code = $2", [r.run_id, r.code])).rows.length > 0;
        out.push({
          site: a.site_id,
          runId: r.run_id,
          stage: r.code,
          asset: a.id,
          state: st.state,
          startedAt: sec(st.startedAt),
          endedAt: st.workDoneAt ? sec(st.workDoneAt) : null,
          subject: stageSubject(a.site_id, r.run_id, r.code).toString(),
          anchor,
          signed,
        });
      }
    }
    return out;
  }

  async submitFromDevice(device: Address, s: ReadingSubmission) {
    const run = await this.db.query<{ site_id: string }>("SELECT site_id FROM runs WHERE id = $1", [s.runId]);
    const siteId = run.rows[0]?.site_id;
    if (!siteId) throw new HttpError(404, "Run not found");
    const st = (await this.engine.view(siteId, s.runId)).stages.find((x) => x.code === s.stage);
    if (!st?.assetId || !(await this.assetsOf(device)).some((a) => a.id === st.assetId)) throw new HttpError(403, "This gateway is not the data source of that stage's machine");
    return this.accept(siteId, st, { signer: device, kind: "device" }, s);
  }

  // ---------------------------------------------------------------- operator readings
  /** Typed data for the operator of a stage with no gateway to sign the counts they recorded. */
  async operatorRequest(siteId: string, user: User, runId: string, stage: string, counts: { good: number; scrap: number }) {
    const st = await this.operatorStage(siteId, runId, stage);
    const salt = BigInt(`0x${randomBytes(31).toString("hex")}`) % FIELD;
    const window = this.windowOf(st);
    const subject = stageSubject(siteId, runId, stage);
    const commitment = await readingCommitment(subject, { good: BigInt(counts.good), scrap: BigInt(counts.scrap), startedAt: BigInt(window.startedAt), endedAt: BigInt(window.endedAt) }, salt);
    const message = { site: siteId, runId, stage, asset: st.assetId ?? "", commitment: commitment.toString(), anchor: await this.latestAnchor(), signedAt: String(Math.floor(this.now() / 1000)) };
    return { typed: { domain: PROOF_DOMAIN, types: READING_TYPES, primaryType: "OrdoReading" as const, message }, salt: salt.toString(), window, signer: user.address };
  }

  async submitFromOperator(siteId: string, user: User, s: ReadingSubmission) {
    const st = await this.operatorStage(siteId, s.runId, s.stage);
    return this.accept(siteId, st, { signer: user.address.toLowerCase() as Address, kind: "operator" }, s);
  }

  private async operatorStage(siteId: string, runId: string, stage: string) {
    const st = (await this.engine.view(siteId, runId)).stages.find((x) => x.code === stage);
    if (!st) throw new HttpError(404, "Stage not found");
    if (st.assetId) {
      const a = await this.plant.asset(siteId, st.assetId);
      if (a.source.type === "gateway") throw new HttpError(409, "This stage's machine has a gateway: it signs the counts");
    }
    return st;
  }

  // ---------------------------------------------------------------- checks
  /** The window a reading covers: the stage's start to when its work finished. */
  private windowOf(st: { startedAt: string | null; workDoneAt: string | null }) {
    if (!st.startedAt || !st.workDoneAt) throw new HttpError(409, "The stage's work has not finished yet");
    return { startedAt: sec(st.startedAt), endedAt: sec(st.workDoneAt) };
  }

  private async accept(siteId: string, st: { code: string; assetId: string | null; startedAt: string | null; workDoneAt: string | null; unitsGood: number; unitsScrap: number }, who: { signer: Address; kind: "device" | "operator" }, s: ReadingSubmission) {
    const window = this.windowOf(st);
    if (!Number.isSafeInteger(s.good) || !Number.isSafeInteger(s.scrap) || s.good < 0 || s.scrap < 0) throw new HttpError(400, "Counts are whole numbers");
    if (Math.abs(s.signedAt - this.now() / 1000) > SKEW_S * 5) throw new HttpError(400, "signedAt is too far from Ordo's clock");
    if (!(await this.knownAnchor(s.anchor))) throw new HttpError(400, "Unknown anchor: sign the newest ledger anchor Ordo gave you");
    const subject = stageSubject(siteId, s.runId, st.code);
    let salt: bigint;
    try {
      salt = BigInt(s.salt);
    } catch {
      throw new HttpError(400, "salt is a field element");
    }
    if (salt <= 0n || salt >= FIELD) throw new HttpError(400, "salt is a field element");
    const commitment = await readingCommitment(subject, { good: BigInt(s.good), scrap: BigInt(s.scrap), startedAt: BigInt(window.startedAt), endedAt: BigInt(window.endedAt) }, salt);
    if (commitment.toString() !== s.commitment) throw new HttpError(400, "The commitment is not Poseidon(subject, good, scrap, startedAt, endedAt, salt) over the stage's window");
    const message: ReadingMessage = { site: siteId, runId: s.runId, stage: st.code, asset: st.assetId ?? "", commitment, anchor: s.anchor, signedAt: BigInt(s.signedAt) };
    const signer = await recoverTypedDataAddress({ domain: PROOF_DOMAIN, types: READING_TYPES, primaryType: "OrdoReading", message, signature: s.signature }).catch(() => null);
    if (signer?.toLowerCase() !== who.signer) throw new HttpError(401, "The reading's signature is not the signer's");
    const matches = s.good === st.unitsGood && s.scrap === st.unitsScrap;
    const ins = await this.db.query(
      `INSERT INTO stage_readings (run_id, stage_code, site_id, asset_id, signer, signer_kind, good, scrap, started_at_s, ended_at_s, salt, subject, commitment, anchor, signed_at_s, signature, matches)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING RETURNING run_id`,
      [s.runId, st.code, siteId, st.assetId, who.signer, who.kind, s.good, s.scrap, window.startedAt, window.endedAt, salt.toString(), subject.toString(), commitment.toString(), s.anchor, s.signedAt, s.signature, matches],
    );
    if (!ins.rows.length) throw new HttpError(409, "This stage's counts are already signed");
    // the ledger gets the commitment and who signed it, never the counts
    const d = await this.rec.decide(siteId, {
      agent: who.kind === "device" ? `device:${who.signer}` : `user:${who.signer}`,
      kind: "stage.reading_signed",
      runId: s.runId,
      stageCode: st.code,
      assetId: st.assetId,
      summary: `${who.kind === "device" ? "The machine's gateway" : "The operator"} signed ${st.code}'s counts${matches ? "" : ", which differ from the counts Ordo recorded"}`,
      data: { signer: who.signer, signerKind: who.kind, commitment: commitment.toString(), anchor: s.anchor, matches },
    });
    await this.db.query("UPDATE stage_readings SET ledger_seq = $1 WHERE run_id = $2 AND stage_code = $3", [d.ledgerSeq ?? null, s.runId, st.code]);
    return { runId: s.runId, stage: st.code, signer: who.signer, commitment: commitment.toString(), matches };
  }

  private async latestAnchor(): Promise<Hex> {
    const r = await this.db.query<{ entry_hash: string }>("SELECT entry_hash FROM anchors ORDER BY id DESC LIMIT 1");
    return r.rows[0] ? anchorHex(r.rows[0].entry_hash) : ZERO_ROOT;
  }
  private async knownAnchor(a: Hex): Promise<boolean> {
    const r = await this.db.query<{ entry_hash: string }>("SELECT entry_hash FROM anchors ORDER BY id DESC LIMIT 50");
    if (!r.rows.length) return a === ZERO_ROOT;
    return r.rows.some((x) => anchorHex(x.entry_hash).toLowerCase() === a.toLowerCase());
  }
}

/** What a gateway signs to authenticate one request. */
export const edgeMessage = (ts: number, method: string, path: string, body: string) => `ordo-edge:${ts}:${method.toUpperCase()}:${path}:${createHash("sha256").update(body).digest("hex")}`;
