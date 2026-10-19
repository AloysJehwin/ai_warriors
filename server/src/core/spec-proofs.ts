import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Groth16Proof } from "snarkjs";
import type { Db } from "../db/db.js";
import type { Criterion } from "../domain/types.js";
import type { CriterionResult } from "../pipelines/criteria.js";
import type { Recorder } from "./recorder.js";

/** Measurements and targets go into the circuit as fixed point with four decimals, and must fit in 64 bits. */
export const SCALE = 10_000;
const MAX = 2n ** 64n;
const OPS: Record<Criterion["op"], number> = { ">=": 0, "<=": 1, "==": 2 };
/** The BN254 scalar field: everything the circuit takes is an element of it. */
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const VERIFY_TTL_MS = 60_000;

type Status = "committed" | "proven" | "failed" | "not_met" | "unprovable";
interface Row {
  run_id: string;
  stage_code: string;
  label: string;
  status: Status;
  subject: string | null;
  value: string | null;
  salt: string | null;
  target: string | null;
  op: number | null;
  commitment: string | null;
  ledger_seq: number | null;
  proof_json: string | null;
  error: string | null;
}

/** What the public passport shows for one criterion: the proof and the public signals, never the measured value. */
export interface SpecProofView {
  status: "proven" | "pending" | "failed";
  /** Groth16 over BN254; verify with the key at /v1/public/zk/spec-check or OrdoSpecVerifier on-chain */
  system: "groth16-bn254";
  circuit: "spec_check";
  /** [subject, target × 10⁴, op (0 ≥, 1 ≤, 2 =), commitment] */
  publicSignals: string[] | null;
  proof: Groth16Proof | null;
  /** the ledger entry that recorded the commitment when the stage closed */
  ledgerSeq: number | null;
  /** checked here just now: the proof verifies, its commitment is the ledger's, and its subject and target are this criterion's */
  verified: boolean | null;
  detail: string;
}

/** The field element a proof is bound to: this lot, this stage, this criterion. */
export function subjectOf(runId: string, stageCode: string, label: string): bigint {
  return BigInt(`0x${createHash("sha256").update(`ordo:spec:${runId}:${stageCode}:${label}`).digest("hex")}`) % FIELD;
}
/** Fixed point for the circuit, rounding down: v ≥ t and v ≤ t survive the rounding exactly when t has ≤ 4 decimals. */
export function scaled(x: number): bigint | null {
  if (!Number.isFinite(x) || x < 0) return null;
  const s = BigInt(Math.floor(x * SCALE + 1e-9));
  return s < MAX ? s : null;
}

let snarkjsReady: Promise<typeof import("snarkjs")> | null = null;
/**
 * snarkjs, on one thread: its worker threads cannot start from a bundled build (Vercel). Verification builds the
 * shared multi-threaded curve, so a single-threaded one is put in its place first.
 */
function snark() {
  snarkjsReady ??= import("snarkjs").then(async (m) => {
    const g = globalThis as { curve_bn128?: unknown };
    g.curve_bn128 ??= await m.curves.getCurveFromName("bn128", { singleThread: true });
    return m;
  });
  return snarkjsReady;
}

interface Artifacts {
  wasm: Uint8Array;
  zkey: Uint8Array;
  vkey: unknown;
}
/** The compiled circuit and its keys (server/zk, built by contracts/scripts/zk-setup.mjs), wherever this build put them. */
function loadArtifacts(): Artifacts | null {
  const dirs = [process.env.ORDO_ZK_DIR, fileURLToPath(new URL("../../zk/", import.meta.url)), fileURLToPath(new URL("./zk/", import.meta.url))].filter(Boolean) as string[];
  const dir = dirs.find((d) => existsSync(join(d, "spec_check.zkey")));
  if (!dir) return null;
  return {
    wasm: new Uint8Array(readFileSync(join(dir, "spec_check.wasm"))),
    zkey: new Uint8Array(readFileSync(join(dir, "spec_check.zkey"))),
    vkey: JSON.parse(readFileSync(join(dir, "verification_key.json"), "utf8")),
  };
}

/**
 * Zero-knowledge proof that a lot met its acceptance criteria, for the public passport, without the measurements.
 * When a stage closes, each measured criterion is committed as Poseidon(subject, value, salt) in the hash-chained
 * ledger (so it is anchored like everything else). Each criterion that passed then gets a Groth16 proof that the
 * committed value meets the target. The passport shows the proof and the commitment; the value and salt stay here.
 */
export class SpecProofs {
  private artifacts: Artifacts | null | undefined;
  private poseidon: Promise<import("circomlibjs").Poseidon> | null = null;
  private checked = new Map<string, { at: number; ok: boolean; detail: string }>();

  constructor(
    private db: Db,
    private rec: Recorder,
    private now: () => number,
  ) {}

  private get zk() {
    if (this.artifacts === undefined) this.artifacts = loadArtifacts();
    return this.artifacts;
  }
  get enabled() {
    return this.zk !== null;
  }
  /** The Groth16 verification key, for anyone who wants to check a passport's proofs themselves. */
  verificationKey() {
    return this.zk?.vkey ?? null;
  }

  private async hash(subject: bigint, value: bigint, salt: bigint) {
    this.poseidon ??= import("circomlibjs").then((m) => m.buildPoseidon());
    const p = await this.poseidon;
    return p.F.toObject(p([subject, value, salt]));
  }

  // ---------------------------------------------------------------- engine cycle
  /** Commit the criteria of stages that just closed, then prove a few that passed. */
  async reconcile(limit = 2): Promise<void> {
    if (!this.enabled) return;
    const stages = await this.db.query<{ run_id: string; code: string; data_json: string }>(
      `SELECT s.run_id, s.code, s.data_json FROM stage_runs s WHERE s.data_json LIKE '%"measured"%'
       AND NOT EXISTS (SELECT 1 FROM spec_proofs z WHERE z.run_id = s.run_id AND z.stage_code = s.code) LIMIT 20`,
    );
    for (const s of stages.rows) await this.commit(s.run_id, s.code, (JSON.parse(s.data_json) as { criteria?: CriterionResult[] }).criteria ?? []);
    const due = await this.db.query<Row>("SELECT * FROM spec_proofs WHERE status = 'committed' ORDER BY created_at LIMIT $1", [limit]);
    for (const r of due.rows) await this.prove(r);
  }

  private async commit(runId: string, stageCode: string, criteria: CriterionResult[]) {
    for (const c of criteria) {
      if (!c.measured) continue;
      const value = scaled(c.measured.value);
      const target = scaled(c.measured.target);
      const exact = target !== null && Math.abs(c.measured.target * SCALE - Number(target)) < 1e-6;
      let row: Partial<Row> & { status: Status };
      if (c.ok !== true) row = { status: "not_met" };
      else if (value === null || target === null || !exact) row = { status: "unprovable", error: "The measurement or target does not fit the circuit (non-negative, four decimals, 64 bits)" };
      else {
        const subject = subjectOf(runId, stageCode, c.label);
        const salt = BigInt(`0x${randomBytes(31).toString("hex")}`);
        const commitment = await this.hash(subject, value, salt);
        const op = OPS[c.measured.op];
        const entry = await this.rec.event("system:zk", "passport.spec_committed", `${runId}/${stageCode}`, {
          criterion: c.label,
          subject: subject.toString(),
          target: target.toString(),
          op,
          commitment: commitment.toString(),
        });
        row = { status: "committed", subject: subject.toString(), value: value.toString(), salt: salt.toString(), target: target.toString(), op, commitment: commitment.toString(), ledger_seq: entry.seq };
      }
      await this.db.query(
        `INSERT INTO spec_proofs (run_id, stage_code, label, status, subject, value, salt, target, op, commitment, ledger_seq, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [runId, stageCode, c.label, row.status, row.subject ?? null, row.value ?? null, row.salt ?? null, row.target ?? null, row.op ?? null, row.commitment ?? null, row.ledger_seq ?? null, row.error ?? null],
      );
    }
  }

  private async prove(r: Row) {
    const zk = this.zk!;
    try {
      const snarkjs = await snark();
      const input = { value: r.value!, salt: r.salt!, subject: r.subject!, target: r.target!, op: String(r.op), commitment: r.commitment! };
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk.wasm, zk.zkey, undefined, undefined, { singleThread: true });
      await this.db.query("UPDATE spec_proofs SET status = 'proven', proof_json = $1, error = NULL, proven_at = now() WHERE run_id = $2 AND stage_code = $3 AND label = $4", [
        JSON.stringify({ proof, publicSignals }),
        r.run_id,
        r.stage_code,
        r.label,
      ]);
    } catch (e) {
      await this.db.query("UPDATE spec_proofs SET status = 'failed', error = $1 WHERE run_id = $2 AND stage_code = $3 AND label = $4", [e instanceof Error ? e.message : String(e), r.run_id, r.stage_code, r.label]);
    }
  }

  // ---------------------------------------------------------------- reads
  /** Proofs for a lot's criteria, keyed `stageCode|label`, each checked against the proof system and the ledger. */
  async forRun(runId: string): Promise<Map<string, SpecProofView>> {
    const out = new Map<string, SpecProofView>();
    if (!this.enabled) return out;
    const rows = await this.db.query<Row>("SELECT * FROM spec_proofs WHERE run_id = $1 AND status IN ('committed', 'proven', 'failed')", [runId]);
    for (const r of rows.rows) {
      const p = r.proof_json ? (JSON.parse(r.proof_json) as { proof: Groth16Proof; publicSignals: string[] }) : null;
      const base = { system: "groth16-bn254", circuit: "spec_check", ledgerSeq: r.ledger_seq === null ? null : Number(r.ledger_seq) } as const;
      if (r.status === "proven" && p) {
        const check = await this.check(r, p);
        out.set(`${r.stage_code}|${r.label}`, { ...base, status: "proven", publicSignals: p.publicSignals, proof: p.proof, verified: check.ok, detail: check.detail });
      } else
        out.set(`${r.stage_code}|${r.label}`, {
          ...base,
          status: r.status === "failed" ? "failed" : "pending",
          publicSignals: null,
          proof: null,
          verified: null,
          detail: r.status === "failed" ? "The proof could not be generated" : "Committed in the ledger; the proof is being generated",
        });
    }
    return out;
  }

  /** What anyone could check: the proof verifies, and its public signals are the ledger's commitment for this lot's criterion. */
  private async check(r: Row, p: { proof: Groth16Proof; publicSignals: string[] }) {
    const key = `${r.run_id}|${r.stage_code}|${r.label}`;
    const hit = this.checked.get(key);
    if (hit && this.now() - hit.at < VERIFY_TTL_MS) return hit;
    let res: { ok: boolean; detail: string };
    const [subject, target, op, commitment] = p.publicSignals;
    const entry = r.ledger_seq ? (await this.rec.ledger.range(Number(r.ledger_seq), Number(r.ledger_seq)))[0] : undefined;
    const recorded = entry?.payload as { commitment?: string; subject?: string; target?: string; op?: number } | undefined;
    if (subject !== subjectOf(r.run_id, r.stage_code, r.label).toString()) res = { ok: false, detail: "The proof is for another lot or criterion" };
    else if (target !== r.target || op !== String(r.op)) res = { ok: false, detail: "The proof is for another target" };
    else if (entry?.type !== "passport.spec_committed" || recorded?.commitment !== commitment || recorded?.subject !== subject || recorded?.target !== target || String(recorded?.op) !== op)
      res = { ok: false, detail: "The commitment does not match the ledger" };
    else {
      const snarkjs = await snark();
      const ok = await snarkjs.groth16.verify(this.zk!.vkey, p.publicSignals, p.proof).catch(() => false);
      res = { ok, detail: ok ? `Zero-knowledge proof verified against the commitment in ledger entry #${entry.seq}` : "The proof does not verify" };
    }
    const v = { at: this.now(), ...res };
    this.checked.set(key, v);
    return v;
  }
}
