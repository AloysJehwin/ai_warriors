import { createHash } from "node:crypto";
import type { Hex } from "viem";
import type { ReleaseTyped, Signatures, TypedSignature, User } from "../auth/auth.js";
import { chainErrorMessage } from "../chain/errors.js";
import { CHAIN_ROLE, releaseSigArg, sigArg, type ChainRole, type ReleaseLot, type ReleaseSigArg, type TrustChain } from "../chain/trust.js";
import type { Db, Queryable } from "../db/db.js";
import { hashOf } from "../domain/canonical.js";
import { canApproveAny } from "../domain/policy.js";
import { ROLE_LABEL, ROLES, type Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { newId } from "../plant/plant.js";
import { WorldId } from "../chain/worldid.js";
import type { Recorder } from "./recorder.js";
import type { Schedules } from "./schedules.js";

export const ONBOARDING_KINDS = ["member", "validator", "vendor"] as const;
export type OnboardingKind = (typeof ONBOARDING_KINDS)[number];
export const VALIDATOR_SCOPES = { quality: "quality_engineer", process: "process_engineer", plant: "plant_manager" } as const satisfies Record<string, Role>;
export type ValidatorScope = keyof typeof VALIDATOR_SCOPES;
// A maintenance lead holds the supervisor credential on-chain: it lets them release work order payments.
const MEMBER_CHAIN_ROLE: Partial<Record<Role, ChainRole>> = { operator: "OPERATOR", supervisor: "SUPERVISOR", maintenance_lead: "SUPERVISOR", plant_manager: "PLANT_MANAGER", admin: "ADMIN" };
const MAX_FILE = 4 * 1024 * 1024;

interface RequestRow {
  id: string;
  site_id: string;
  user_id: string;
  address: string;
  kind: OnboardingKind;
  role: string;
  form_json: string;
  files_json: string;
  status: "pending" | "approved" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  signature_id: string | null;
  created_at: string;
  display_name: string | null;
  world_id_nullifier: string | null;
}
export interface OnboardingView {
  id: string;
  siteId: string;
  userId: string;
  address: string;
  name: string | null;
  kind: OnboardingKind;
  role: string;
  roleLabel: string;
  form: Record<string, string>;
  files: { name: string; sha256: string; size: number; mime: string }[];
  status: RequestRow["status"];
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string;
  chain: RelayView | null;
  /** the applicant proved with World ID that they are a person not already validating here */
  humanVerified: boolean;
}
export interface RelayView {
  kind: string;
  status: "pending" | "done" | "failed" | "waiting_site";
  txHash: string | null;
  txUrl: string | null;
  error: string | null;
}

const iso = (s: string | null) => (s ? new Date(s).toISOString() : null);
// relay payloads are stored as JSON, where a bigint deadline is a string
const jsonSafe = (s: ReleaseSigArg) => ({ ...s, deadline: s.deadline.toString() });
const fromJsonSafe = (s: ReturnType<typeof jsonSafe>): ReleaseSigArg => ({ ...s, deadline: BigInt(s.deadline) });

/**
 * Who may do what, and the proof of it. Onboarding requests become roles only with a site
 * admin's EIP-712 signature; validators are people whose validator onboarding was approved and,
 * when the trust contract is configured, who hold an active stake on-chain. With World ID configured,
 * each validator is also one verified person: a person holds one validator seat per site, whatever
 * wallet they apply from. Every grant, release and slash the contract can verify is relayed to it with
 * the original signatures.
 */
export class Trust {
  /** Set when Hedera's Schedule Service returns stakes at the end of the unstake cooldown */
  schedules: Schedules | null = null;
  /** set when World ID is configured: validators must prove they are a person not already validating at the site */
  worldId: WorldId | null = null;
  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    readonly chain: TrustChain | null,
    private defaultChainId: number,
  ) {}

  /** Chain id for signatures the contract will verify; otherwise the wallet's own. */
  chainIdFor(contractChecked: boolean, client?: number): number {
    if (contractChecked && this.chain) return this.chain.cfg.chainId;
    return client ?? this.defaultChainId;
  }
  /** The domain for a signature OrdoTrust verifies: its chain and its address, so it cannot be replayed on another deployment. */
  contractDomain(contractChecked: boolean, client?: number): { chainId: number; verifyingContract?: Hex } {
    if (contractChecked && this.chain) return { chainId: this.chain.cfg.chainId, verifyingContract: this.chain.cfg.address };
    return { chainId: client ?? this.defaultChainId };
  }

  // ---------------------------------------------------------------- onboarding
  private roleFor(kind: OnboardingKind, role: string): string {
    if (kind === "validator") return VALIDATOR_SCOPES[role as ValidatorScope] ? role : (() => { throw new HttpError(400, "Choose a validator scope: quality, process or plant"); })();
    if (kind === "vendor") return "vendor";
    if (!(ROLES as readonly string[]).includes(role) || role === "admin") throw new HttpError(400, "Choose a role");
    return role;
  }
  chainRoleOf(kind: OnboardingKind, role: string): ChainRole | null {
    if (kind === "validator") return "VALIDATOR";
    if (kind === "vendor") return "VENDOR";
    return MEMBER_CHAIN_ROLE[role as Role] ?? null;
  }
  private entityOf(r: { address: string; kind: OnboardingKind; role: string }) {
    return `${r.address}#${this.chainRoleOf(r.kind, r.role) ?? r.role.toUpperCase()}`;
  }
  static labelOf(kind: OnboardingKind, role: string) {
    if (kind === "validator") return `Validator · ${ROLE_LABEL[VALIDATOR_SCOPES[role as ValidatorScope]]}`;
    if (kind === "vendor") return "Maintenance vendor";
    return ROLE_LABEL[role as Role] ?? role;
  }

  async publicSite(siteId: string) {
    const s = (await this.db.query<{ id: string; name: string }>("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!s) throw new HttpError(404, "No site with that code");
    return s;
  }

  async submit(siteId: string, user: User, input: { kind: OnboardingKind; role: string; form: Record<string, string>; worldId?: unknown }): Promise<OnboardingView> {
    await this.publicSite(siteId);
    const role = this.roleFor(input.kind, input.role);
    const form = Object.fromEntries(Object.entries(input.form).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 2000)]));
    if (!form.fullName?.trim()) throw new HttpError(400, "Full name is required");
    if (input.kind === "vendor" && !form.company?.trim()) throw new HttpError(400, "Company is required");
    if (input.kind === "validator" && !form.qualifications?.trim()) throw new HttpError(400, "Describe your qualifications");
    const dup = await this.db.query("SELECT 1 FROM onboarding_requests WHERE site_id = $1 AND user_id = $2 AND kind = $3 AND role = $4 AND status = 'pending'", [siteId, user.id, input.kind, role]);
    if (dup.rows.length) throw new HttpError(409, "You already have a pending request for this");
    let nullifier: string | null = null;
    if (input.kind === "validator" && this.worldId) {
      if (!input.worldId) throw new HttpError(400, "Validators verify with World ID: one person, one validator at a site");
      nullifier = (await this.worldId.verify(input.worldId, user.address)).nullifier;
      await this.assertOneHuman(this.db, siteId, user.id, nullifier);
      const other = await this.db.query("SELECT 1 FROM onboarding_requests WHERE site_id = $1 AND world_id_nullifier = $2 AND user_id <> $3 AND status = 'pending'", [siteId, nullifier, user.id]);
      if (other.rows.length) throw new HttpError(409, "You already applied as a validator at this site from another wallet");
    }
    const id = newId("onb");
    await this.db.query("INSERT INTO onboarding_requests (id, site_id, user_id, address, kind, role, form_json, world_id_nullifier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, siteId, user.id, user.address, input.kind, role, JSON.stringify(form), nullifier]);
    await this.rec.decide(siteId, {
      agent: `user:${user.address}`,
      kind: "onboarding.submitted",
      summary: `${form.fullName} applied as ${Trust.labelOf(input.kind, role)}`,
      data: { requestId: id, kind: input.kind, role, formHash: hashOf(form), ...(nullifier ? { worldId: WorldId.ledgerRef(siteId, nullifier) } : {}) },
    });
    return this.get(siteId, id);
  }

  async attach(siteId: string, user: User, id: string, f: { name: string; mime: string; bytes: Uint8Array }) {
    const r = await this.row(siteId, id);
    if (r.user_id !== user.id) throw new HttpError(403, "Only the applicant can attach files");
    if (r.status !== "pending") throw new HttpError(409, "The request is already decided");
    if (f.bytes.byteLength > MAX_FILE) throw new HttpError(400, "Files are limited to 4 MB");
    const sha = createHash("sha256").update(f.bytes).digest("hex");
    await this.db.query("INSERT INTO blobs (sha256, mime, size, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING", [sha, f.mime, f.bytes.byteLength, Buffer.from(f.bytes)]);
    const files = JSON.parse(r.files_json) as OnboardingView["files"];
    files.push({ name: f.name.slice(0, 120), sha256: `sha256:${sha}`, size: f.bytes.byteLength, mime: f.mime });
    await this.db.query("UPDATE onboarding_requests SET files_json = $1 WHERE id = $2", [JSON.stringify(files), id]);
    await this.rec.event(`user:${user.address}`, "onboarding.file", id, { site: siteId, name: f.name, sha256: `sha256:${sha}` });
    return this.get(siteId, id);
  }

  async file(siteId: string, id: string, sha: string) {
    const r = await this.row(siteId, id);
    const f = (JSON.parse(r.files_json) as OnboardingView["files"]).find((x) => x.sha256 === sha);
    if (!f) throw new HttpError(404, "File not found");
    const b = (await this.db.query<{ bytes: Uint8Array }>("SELECT bytes FROM blobs WHERE sha256 = $1", [sha.replace("sha256:", "")])).rows[0];
    if (!b) throw new HttpError(404, "File not found");
    return { ...f, bytes: b.bytes };
  }

  private async row(siteId: string, id: string): Promise<RequestRow> {
    const r = await this.db.query<RequestRow>(
      "SELECT o.*, o.created_at::text AS created_at, o.decided_at::text AS decided_at, u.display_name FROM onboarding_requests o JOIN users u ON u.id = o.user_id WHERE o.id = $1 AND o.site_id = $2",
      [id, siteId],
    );
    if (!r.rows[0]) throw new HttpError(404, "Request not found");
    return r.rows[0];
  }
  private async view(r: RequestRow): Promise<OnboardingView> {
    return {
      id: r.id,
      siteId: r.site_id,
      userId: r.user_id,
      address: r.address,
      name: r.display_name ?? (JSON.parse(r.form_json) as Record<string, string>).fullName ?? null,
      kind: r.kind,
      role: r.role,
      roleLabel: Trust.labelOf(r.kind, r.role),
      form: JSON.parse(r.form_json),
      files: JSON.parse(r.files_json),
      status: r.status,
      decidedBy: r.decided_by,
      decidedAt: iso(r.decided_at),
      reason: r.reason,
      createdAt: new Date(r.created_at).toISOString(),
      chain: await this.relayOf(r.site_id, r.id),
      humanVerified: Boolean(r.world_id_nullifier),
    };
  }
  async get(siteId: string, id: string) {
    return this.view(await this.row(siteId, id));
  }
  async list(siteId: string, status?: string): Promise<OnboardingView[]> {
    const r = await this.db.query<RequestRow>(
      `SELECT o.*, o.created_at::text AS created_at, o.decided_at::text AS decided_at, u.display_name FROM onboarding_requests o JOIN users u ON u.id = o.user_id
       WHERE o.site_id = $1 ${status && status !== "all" ? "AND o.status = $2" : ""} ORDER BY (o.status = 'pending') DESC, o.created_at DESC LIMIT 200`,
      status && status !== "all" ? [siteId, status] : [siteId],
    );
    return Promise.all(r.rows.map((x) => this.view(x)));
  }
  async mine(user: User) {
    const r = await this.db.query<RequestRow & { site_name: string }>(
      "SELECT o.*, o.created_at::text AS created_at, o.decided_at::text AS decided_at, u.display_name, s.name AS site_name FROM onboarding_requests o JOIN users u ON u.id = o.user_id JOIN sites s ON s.id = o.site_id WHERE o.user_id = $1 ORDER BY o.created_at DESC",
      [user.id],
    );
    return Promise.all(r.rows.map(async (x) => ({ ...(await this.view(x)), siteName: x.site_name })));
  }

  async decisionRequest(siteId: string, admin: User, id: string, decision: "approve" | "reject", comment: string, clientChainId?: number): Promise<TypedSignature> {
    const r = await this.row(siteId, id);
    if (r.status !== "pending") throw new HttpError(409, "Already decided");
    const label = Trust.labelOf(r.kind, r.role);
    const who = (JSON.parse(r.form_json) as Record<string, string>).fullName ?? r.address;
    if (decision === "approve")
      return this.sigs.request(admin, {
        action: "role.grant",
        entity: this.entityOf(r),
        meaning: `Approve ${who} (${r.address}) as ${label}`,
        comment,
        site: siteId,
        ...this.contractDomain(this.chainRoleOf(r.kind, r.role) !== null, clientChainId),
      });
    return this.sigs.request(admin, { action: "onboarding.reject", entity: id, meaning: `Decline ${who} as ${label}`, comment, site: siteId, chainId: clientChainId ?? this.defaultChainId });
  }

  async decide(siteId: string, admin: User, id: string, input: { decision: "approve" | "reject"; comment: string; nonce: string; signature: Hex }): Promise<OnboardingView> {
    const r = await this.row(siteId, id);
    if (r.status !== "pending") throw new HttpError(409, "Already decided");
    const approve = input.decision === "approve";
    const expect = approve ? { action: "role.grant", entity: this.entityOf(r) } : { action: "onboarding.reject", entity: id };
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, admin, expect, { nonce: input.nonce, signature: input.signature });
      const u = await q.query("UPDATE onboarding_requests SET status = $1, decided_by = $2, decided_at = now(), reason = $3, signature_id = $4 WHERE id = $5 AND status = 'pending' RETURNING id", [
        approve ? "approved" : "rejected",
        admin.address,
        input.comment || null,
        s.id,
        id,
      ]);
      if (!u.rows.length) throw new HttpError(409, "Already decided");
      if (approve) await this.apply(q, siteId, r, admin);
      return s;
    });
    const label = Trust.labelOf(r.kind, r.role);
    const d = await this.rec.decide(siteId, {
      agent: `user:${admin.address}`,
      kind: approve ? "onboarding.approved" : "onboarding.rejected",
      summary: `${approve ? "Approved" : "Declined"} ${r.address} as ${label}`,
      reason: input.comment || null,
      data: { requestId: id, signatureId: sig.id, typedData: sig.typed, signature: input.signature },
    });
    await this.db.query("UPDATE signatures SET ledger_seq = $1 WHERE id = $2", [d.ledgerSeq, sig.id]);
    const chainRole = this.chainRoleOf(r.kind, r.role);
    if (approve && chainRole && this.chain) await this.relayGrant(siteId, id, r.address, chainRole, sigArg(sig.typed, input.signature));
    return this.get(siteId, id);
  }

  private async apply(q: Queryable, siteId: string, r: RequestRow, admin: User) {
    const fullName = (JSON.parse(r.form_json) as Record<string, string>).fullName?.trim();
    if (fullName) await q.query("UPDATE users SET display_name = $1 WHERE id = $2 AND display_name IS NULL", [fullName.slice(0, 60), r.user_id]);
    const add = (role: string) => q.query("INSERT INTO memberships (site_id, user_id, role, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [siteId, r.user_id, role, admin.id]);
    if (r.kind === "member") await add(r.role);
    if (r.kind === "validator") {
      if (r.world_id_nullifier) await this.bindHuman(q, siteId, r.user_id, r.address, r.world_id_nullifier);
      await add(VALIDATOR_SCOPES[r.role as ValidatorScope]);
      await q.query(
        "INSERT INTO validators (site_id, user_id, scope, status, request_id) VALUES ($1,$2,$3,'approved',$4) ON CONFLICT (site_id, user_id) DO UPDATE SET scope = EXCLUDED.scope, status = 'approved', request_id = EXCLUDED.request_id, approved_at = now()",
        [siteId, r.user_id, r.role, r.id],
      );
    }
    if (r.kind === "vendor") {
      const f = JSON.parse(r.form_json) as Record<string, string>;
      await q.query("INSERT INTO vendors (id, site_id, user_id, address, company, categories, hourly_rate, response_minutes, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        newId("vnd"),
        siteId,
        r.user_id,
        r.address,
        f.company ?? "",
        f.categories ?? "",
        f.hourlyRate ?? null,
        f.responseMinutes ? Number(f.responseMinutes) || null : null,
        r.id,
      ]);
    }
  }

  // ---------------------------------------------------------------- chain relays
  private retryers = new Map<string, (siteId: string, ref: string, payload: any) => Promise<Hex>>();
  /** Let another module's relays be retried: `run` re-sends a relay of this kind from its stored payload. */
  onRetry(kind: string, run: (siteId: string, ref: string, payload: any) => Promise<Hex>) {
    this.retryers.set(kind, run);
  }

  /** Send a signed authorisation to a contract and record the outcome (pending → done | failed | waiting_site). */
  async relay(siteId: string, kind: string, ref: string, payload: unknown, run: () => Promise<Hex>, waitForSite = true, contract?: string): Promise<RelayView> {
    const id = newId("rly");
    const registered = !waitForSite || (await this.siteRegistered(siteId));
    await this.db.query("INSERT INTO chain_relays (id, site_id, kind, ref, payload_json, status) VALUES ($1,$2,$3,$4,$5,$6)", [id, siteId, kind, ref, JSON.stringify(payload), registered ? "pending" : "waiting_site"]);
    if (!registered) return this.relayView({ kind, status: "waiting_site", tx_hash: null, error: null });
    try {
      const tx = await run();
      await this.db.query("UPDATE chain_relays SET status = 'done', tx_hash = $1, updated_at = now() WHERE id = $2", [tx, id]);
      await this.rec.event("system:relayer", `chain.${kind}`, ref, { site: siteId, txHash: tx, chainId: this.chain!.cfg.chainId, contract: contract ?? this.chain!.cfg.address });
      return this.relayView({ kind, status: "done", tx_hash: tx, error: null });
    } catch (e) {
      const msg = chainErrorMessage(e);
      await this.db.query("UPDATE chain_relays SET status = 'failed', error = $1, updated_at = now() WHERE id = $2", [msg, id]);
      return this.relayView({ kind, status: "failed", tx_hash: null, error: msg });
    }
  }
  private relayView(r: { kind: string; status: string; tx_hash: string | null; error: string | null }): RelayView {
    return { kind: r.kind, status: r.status as RelayView["status"], txHash: r.tx_hash, txUrl: r.tx_hash && this.chain ? this.chain.txUrl(r.tx_hash) : null, error: r.error };
  }
  async relayOf(siteId: string, ref: string): Promise<RelayView | null> {
    const r = (await this.db.query<{ kind: string; status: string; tx_hash: string | null; error: string | null }>("SELECT kind, status, tx_hash, error FROM chain_relays WHERE site_id = $1 AND ref = $2 ORDER BY created_at DESC LIMIT 1", [siteId, ref])).rows[0];
    return r ? this.relayView(r) : null;
  }
  private relayGrant(siteId: string, ref: string, address: string, role: ChainRole, sig: ReturnType<typeof sigArg>) {
    return this.relay(siteId, "grant", ref, { address, role, sig }, () => this.chain!.grantRole(siteId, address, role, sig));
  }
  private relayRevoke(siteId: string, ref: string, address: string, role: ChainRole, sig: ReturnType<typeof sigArg>) {
    return this.relay(siteId, "revoke", ref, { address, role, sig }, () => this.chain!.revokeRole(siteId, address, role, sig));
  }
  /** Retry a failed relay, or one that waited for the site's registration. */
  async retry(siteId: string, ref: string): Promise<RelayView | null> {
    if (!this.chain) throw new HttpError(409, "No trust contract is configured");
    const r = (await this.db.query<{ id: string; kind: string; payload_json: string; status: string }>("SELECT id, kind, payload_json, status FROM chain_relays WHERE site_id = $1 AND ref = $2 ORDER BY created_at DESC LIMIT 1", [siteId, ref])).rows[0];
    if (!r || r.status === "done") return r ? this.relayOf(siteId, ref) : null;
    const p = JSON.parse(r.payload_json);
    await this.db.query("UPDATE chain_relays SET status = 'superseded' WHERE id = $1", [r.id]);
    if (r.kind === "grant") return this.relayGrant(siteId, ref, p.address, p.role, p.sig);
    if (r.kind === "revoke") return this.relayRevoke(siteId, ref, p.address, p.role, p.sig);
    if (r.kind === "release") return this.relay(siteId, "release", ref, p, () => this.chain!.recordRelease(p.lot, p.sigs.map(fromJsonSafe)));
    const other = this.retryers.get(r.kind);
    if (other) return this.relay(siteId, r.kind, ref, p, () => other(siteId, ref, p));
    return null;
  }

  // ---------------------------------------------------------------- site registration
  async siteRegistered(siteId: string): Promise<boolean> {
    return (await this.db.query("SELECT 1 FROM chain_sites WHERE site_id = $1", [siteId])).rows.length > 0;
  }
  async chainStatus(siteId: string) {
    if (!this.chain) return { configured: false as const };
    const reg = (await this.db.query<{ tx_hash: string; registered_at: string }>("SELECT tx_hash, registered_at::text FROM chain_sites WHERE site_id = $1", [siteId])).rows[0];
    const info = await this.chain.info().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    return { configured: true as const, info, registered: Boolean(reg), txHash: reg?.tx_hash ?? null, txUrl: reg ? this.chain.txUrl(reg.tx_hash) : null, registeredAt: iso(reg?.registered_at ?? null) };
  }
  async registerRequest(siteId: string, admin: User, name: string) {
    if (!this.chain) throw new HttpError(409, "No trust contract is configured");
    if (await this.siteRegistered(siteId)) throw new HttpError(409, "This site is already registered on-chain");
    // the admin is also the site's quality fund until a treasury is set; the contract checks both were signed
    return this.sigs.request(admin, {
      action: "site.register",
      entity: `${siteId}#${admin.address.toLowerCase()}`,
      meaning: `Register ${name} in OrdoTrust with you as its first administrator and your wallet as its quality fund`,
      comment: "",
      site: siteId,
      ...this.contractDomain(true),
    });
  }
  async register(siteId: string, admin: User, proof: { nonce: string; signature: Hex }) {
    if (!this.chain) throw new HttpError(409, "No trust contract is configured");
    const sig = await this.db.tx((q) => this.sigs.consume(q, admin, { action: "site.register", entity: `${siteId}#${admin.address.toLowerCase()}` }, proof));
    const tx = await this.chain.registerSite(siteId, admin.address, sigArg(sig.typed, proof.signature)).catch((e: unknown) => {
      throw new HttpError(502, `The contract refused the registration: ${e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : e}`);
    });
    await this.db.query("INSERT INTO chain_sites (site_id, chain_id, contract, tx_hash) VALUES ($1,$2,$3,$4)", [siteId, this.chain.cfg.chainId, this.chain.cfg.address, tx]);
    await this.rec.decide(siteId, { agent: `user:${admin.address}`, kind: "chain.site_registered", summary: `Registered the site in OrdoTrust`, data: { txHash: tx, chainId: this.chain.cfg.chainId, contract: this.chain.cfg.address, signatureId: sig.id } });
    // grants approved before registration go out now
    const waiting = await this.db.query<{ ref: string }>("SELECT DISTINCT ref FROM chain_relays WHERE site_id = $1 AND status = 'waiting_site'", [siteId]);
    for (const w of waiting.rows) await this.retry(siteId, w.ref);
    return this.chainStatus(siteId);
  }

  // ---------------------------------------------------------------- validators
  async validatorRow(siteId: string, userId: string) {
    return (await this.db.query<{ scope: ValidatorScope; status: string }>("SELECT scope, status FROM validators WHERE site_id = $1 AND user_id = $2", [siteId, userId])).rows[0] ?? null;
  }
  /** An approved validator; with the trust contract, also credentialed and staked on-chain right now. */
  async isValidator(siteId: string, user: User): Promise<{ ok: boolean; reason: string | null }> {
    const v = await this.validatorRow(siteId, user.id);
    if (v?.status === "removed") return { ok: false, reason: "An administrator removed you as a validator at this site. Your stake is still yours: unstake and withdraw it here. To validate again, apply again." };
    if (!v || v.status !== "approved") return { ok: false, reason: "Only an approved validator can sign this. Apply as a validator from Team → Validators." };
    if (this.worldId && !(await this.isHuman(siteId, user.id)))
      return { ok: false, reason: "Verify with World ID before you sign (Team → Validators): each validator at a site must be a different person." };
    if (!this.chain) return { ok: true, reason: null };
    const active = await this.chain.isActiveValidator(siteId, user.address).catch(() => null);
    if (active === null) return { ok: false, reason: "Could not reach the trust contract to check your stake. Try again." };
    const roles = active ? null : await this.chain.roles(siteId, user.address).catch(() => null);
    if (roles !== null && (roles & CHAIN_ROLE.VALIDATOR) === 0)
      return { ok: false, reason: "Your validator credential is not in OrdoTrust yet, so the contract refuses your stake. An administrator can retry it from Team → Validators." };
    if (!active) return { ok: false, reason: "Your validator stake is not active on-chain: stake at least the minimum (Team → Validators), and make sure you have not requested to unstake." };
    return { ok: true, reason: null };
  }
  async requireValidator(siteId: string, user: User) {
    const r = await this.isValidator(siteId, user);
    if (!r.ok) throw new HttpError(403, r.reason!);
  }

  // ---------------------------------------------------------------- one person per validator (World ID)
  async isHuman(siteId: string, userId: string) {
    return (await this.db.query("SELECT 1 FROM validator_humans WHERE site_id = $1 AND user_id = $2", [siteId, userId])).rows.length > 0;
  }
  private async assertOneHuman(q: Queryable, siteId: string, userId: string, nullifier: string) {
    const held = (await q.query<{ user_id: string }>("SELECT user_id FROM validator_humans WHERE site_id = $1 AND nullifier = $2", [siteId, nullifier])).rows[0];
    if (held && held.user_id !== userId) throw new HttpError(409, "You already validate at this site from another wallet: one person holds one validator seat per site");
  }
  private async bindHuman(q: Queryable, siteId: string, userId: string, address: string, nullifier: string) {
    await this.assertOneHuman(q, siteId, userId, nullifier);
    const mine = (await q.query<{ nullifier: string }>("SELECT nullifier FROM validator_humans WHERE site_id = $1 AND user_id = $2", [siteId, userId])).rows[0];
    if (mine && mine.nullifier !== nullifier) throw new HttpError(409, "This wallet is already verified at this site as a different World ID");
    if (!mine) await q.query("INSERT INTO validator_humans (site_id, nullifier, user_id, address) VALUES ($1,$2,$3,$4)", [siteId, nullifier, userId, address]);
  }
  /** World ID for a validator approved before the site required it, or whose application predates it. */
  async verifyHuman(siteId: string, user: User, result: unknown) {
    if (!this.worldId) throw new HttpError(409, "World ID is not configured");
    const v = await this.validatorRow(siteId, user.id);
    if (!v || v.status !== "approved") throw new HttpError(403, "Only an approved validator verifies here; apply as a validator with World ID instead");
    const { nullifier } = await this.worldId.verify(result, user.address);
    await this.db.tx((q) => this.bindHuman(q, siteId, user.id, user.address, nullifier));
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "validator.human_verified", summary: `${user.address} verified with World ID as a unique person`, data: { worldId: WorldId.ledgerRef(siteId, nullifier) } });
    return { human: true };
  }

  // ---------------------------------------------------------------- removing a validator
  private async approvedValidator(siteId: string, userId: string) {
    const v = (
      await this.db.query<{ scope: ValidatorScope; status: string; address: string; display_name: string | null }>(
        "SELECT v.scope, v.status, u.address, u.display_name FROM validators v JOIN users u ON u.id = v.user_id WHERE v.site_id = $1 AND v.user_id = $2",
        [siteId, userId],
      )
    ).rows[0];
    if (!v || v.status !== "approved") throw new HttpError(404, "No approved validator with that id at this site");
    return v;
  }
  /** What the administrator signs to take a validator's seat away: the same "role.revoke" OrdoTrust checks before it revokes VALIDATOR. */
  async removeRequest(siteId: string, admin: User, userId: string, comment: string, clientChainId?: number): Promise<TypedSignature> {
    const v = await this.approvedValidator(siteId, userId);
    return this.sigs.request(admin, {
      action: "role.revoke",
      entity: `${v.address}#VALIDATOR`,
      meaning: `Remove ${v.display_name ?? v.address} (${v.address}) as ${Trust.labelOf("validator", v.scope)}`,
      comment,
      site: siteId,
      ...this.contractDomain(true, clientChainId),
    });
  }
  /**
   * The validator stops signing at once: their seat and their World ID binding at this site go, so the same person can
   * validate again later from any wallet. They stay on the team (Team removes roles), which keeps the Validators page open
   * to them: their stake stays theirs, and the contract lets them unstake and withdraw without the credential.
   */
  async remove(siteId: string, admin: User, userId: string, input: { comment: string; nonce: string; signature: Hex }) {
    const v = await this.approvedValidator(siteId, userId);
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, admin, { action: "role.revoke", entity: `${v.address}#VALIDATOR` }, { nonce: input.nonce, signature: input.signature });
      const u = await q.query("UPDATE validators SET status = 'removed' WHERE site_id = $1 AND user_id = $2 AND status = 'approved' RETURNING user_id", [siteId, userId]);
      if (!u.rows.length) throw new HttpError(409, "This validator was already removed");
      await q.query("DELETE FROM validator_humans WHERE site_id = $1 AND user_id = $2", [siteId, userId]);
      return s;
    });
    const d = await this.rec.decide(siteId, {
      agent: `user:${admin.address}`,
      kind: "validator.removed",
      summary: `Removed ${v.display_name ?? v.address} as ${Trust.labelOf("validator", v.scope)}`,
      reason: input.comment || null,
      data: { userId, address: v.address, scope: v.scope, signatureId: sig.id, typedData: sig.typed, signature: input.signature },
    });
    await this.db.query("UPDATE signatures SET ledger_seq = $1 WHERE id = $2", [d.ledgerSeq, sig.id]);
    const chain = this.chain ? await this.relayRevoke(siteId, `valrm_${userId}_${sig.id}`, v.address, "VALIDATOR", sigArg(sig.typed, input.signature)) : null;
    return { removed: true, chain };
  }

  async validators(siteId: string) {
    const rows = await this.db.query<{ user_id: string; scope: ValidatorScope; status: string; approved_at: string; address: string; display_name: string | null; human: boolean; request_id: string | null }>(
      "SELECT v.user_id, v.scope, v.status, v.approved_at::text, v.request_id, u.address, u.display_name, EXISTS (SELECT 1 FROM validator_humans h WHERE h.site_id = v.site_id AND h.user_id = v.user_id) AS human FROM validators v JOIN users u ON u.id = v.user_id WHERE v.site_id = $1 ORDER BY v.approved_at",
      [siteId],
    );
    return Promise.all(
      rows.rows.map(async (v) => {
        const onchain = this.chain
          ? await Promise.all([this.chain.stakeOf(siteId, v.address), this.chain.isActiveValidator(siteId, v.address), this.schedules?.stakeSchedule(siteId, v.address) ?? null, this.chain.roles(siteId, v.address)])
              .then(([s, a, payout, roles]) => ({ stake: s.amount, unlockAt: s.unlockAt, active: a, payout, credentialed: (roles & CHAIN_ROLE.VALIDATOR) !== 0 }))
              .catch(() => null)
          : null;
        // the relay that put (or failed to put) the credential on-chain: an administrator retries a failed one by this ref
        const credential = this.chain && v.request_id ? await this.relayOf(siteId, v.request_id) : null;
        return { requestId: v.request_id, credential, userId: v.user_id, address: v.address, name: v.display_name, scope: v.scope, scopeLabel: ROLE_LABEL[VALIDATOR_SCOPES[v.scope]], status: v.status, approvedAt: new Date(v.approved_at).toISOString(), human: Boolean(v.human), onchain };
      }),
    );
  }

  async vendors(siteId: string) {
    const r = await this.db.query<{ id: string; address: string; company: string; categories: string; hourly_rate: string | null; response_minutes: number | null; status: string; created_at: string }>(
      "SELECT id, address, company, categories, hourly_rate, response_minutes, status, created_at::text FROM vendors WHERE site_id = $1 ORDER BY created_at",
      [siteId],
    );
    return r.rows.map((v) => ({ id: v.id, address: v.address, company: v.company, categories: v.categories, hourlyRate: v.hourly_rate, responseMinutes: v.response_minutes, status: v.status, createdAt: new Date(v.created_at).toISOString() }));
  }

  // ---------------------------------------------------------------- releases on-chain
  /** Relay a released validation package's three release statements to the contract. */
  async recordRelease(siteId: string, lot: ReleaseLot): Promise<RelayView | null> {
    if (!this.chain) return null;
    const sigs = await this.releaseSigs(lot.packageId);
    return this.relay(siteId, "release", lot.packageId, { lot, sigs: sigs.map(jsonSafe) }, () => this.chain!.recordRelease(lot, sigs));
  }

  /** The package's three current release statements, [performed, reviewed, approved], as the contracts take them. */
  async releaseSigs(packageId: string): Promise<[ReleaseSigArg, ReleaseSigArg, ReleaseSigArg]> {
    const rows = await this.db.query<{ meaning: string; typed_data: string; signature: string }>(
      "SELECT ps.meaning, s.typed_data, s.signature FROM package_signatures ps JOIN signatures s ON s.id = ps.signature_id WHERE ps.package_id = $1 AND ps.cleared_at IS NULL",
      [packageId],
    );
    const by = (m: string) => {
      const r = rows.rows.find((x) => x.meaning === m);
      if (!r) throw new HttpError(409, `Missing the ${m} signature`);
      const typed = JSON.parse(r.typed_data) as ReleaseTyped | TypedSignature;
      if (typed.primaryType !== "OrdoRelease") throw new HttpError(409, `The ${m} signature predates release statements: return the package and sign it again`);
      return releaseSigArg(typed, r.signature);
    };
    return [by("performed"), by("reviewed"), by("approved")];
  }

  // ---------------------------------------------------------------- slashing
  async proposals(siteId: string) {
    const p = await this.db.query<{ id: string; validator_user_id: string; validator_address: string; amount: string; reason: string; recall_package_id: string | null; created_by: string; status: string; created_at: string; executed_at: string | null }>(
      "SELECT id, validator_user_id, validator_address, amount, reason, recall_package_id, created_by, status, created_at::text, executed_at::text FROM slash_proposals WHERE site_id = $1 ORDER BY created_at DESC",
      [siteId],
    );
    return Promise.all(
      p.rows.map(async (x) => {
        const s = await this.db.query<{ user_id: string; address: string; capacity: string; created_at: string }>("SELECT user_id, address, capacity, created_at::text FROM slash_signatures WHERE proposal_id = $1 ORDER BY created_at", [x.id]);
        return {
          id: x.id,
          validatorUserId: x.validator_user_id,
          validatorAddress: x.validator_address,
          amount: x.amount,
          reason: x.reason,
          recallPackageId: x.recall_package_id,
          createdBy: x.created_by,
          status: x.status,
          createdAt: new Date(x.created_at).toISOString(),
          executedAt: iso(x.executed_at),
          signatures: s.rows.map((r) => ({ userId: r.user_id, address: r.address, capacity: r.capacity, at: new Date(r.created_at).toISOString() })),
          chain: await this.relayOf(siteId, x.id),
        };
      }),
    );
  }

  async propose(siteId: string, user: User, roles: Role[], input: { validatorUserId: string; amount: string; reason: string; recallPackageId?: string | null }) {
    if (!this.chain) throw new HttpError(409, "Slashing needs the trust contract: stakes live on-chain");
    if (!canApproveAny(roles, "plant_manager")) throw new HttpError(403, "A plant manager opens a slash proposal");
    const v = await this.db.query<{ address: string }>("SELECT u.address FROM validators v JOIN users u ON u.id = v.user_id WHERE v.site_id = $1 AND v.user_id = $2", [siteId, input.validatorUserId]);
    if (!v.rows[0]) throw new HttpError(404, "Validator not found");
    if (!/^\d+$/.test(input.amount) || BigInt(input.amount) <= 0n) throw new HttpError(400, "Amount must be a positive whole number of contract units");
    const stake = await this.chain.stakeOf(siteId, v.rows[0].address);
    if (BigInt(input.amount) > BigInt(stake.amount)) throw new HttpError(400, "Amount is more than the validator's stake");
    const id = newId("slash");
    await this.db.query("INSERT INTO slash_proposals (id, site_id, validator_user_id, validator_address, amount, reason, recall_package_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
      id,
      siteId,
      input.validatorUserId,
      v.rows[0].address,
      input.amount,
      input.reason,
      input.recallPackageId ?? null,
      user.address,
    ]);
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "validator.slash_proposed", summary: `Proposed slashing ${v.rows[0].address}`, reason: input.reason, data: { proposalId: id, amount: input.amount, recallPackageId: input.recallPackageId ?? null } });
    return id;
  }

  private async proposal(siteId: string, id: string) {
    const p = (await this.db.query<{ id: string; validator_user_id: string; validator_address: string; amount: string; status: string }>("SELECT id, validator_user_id, validator_address, amount, status FROM slash_proposals WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!p) throw new HttpError(404, "Proposal not found");
    if (p.status !== "open") throw new HttpError(409, "The proposal is closed");
    return p;
  }
  private slashEntity(p: { validator_address: string; amount: string; id: string }) {
    return `${p.validator_address}#${p.amount}#${p.id}`;
  }
  /** What this person would sign as: a second validator voice, or the plant manager's. */
  private async capacityOf(siteId: string, user: User, roles: Role[], p: { id: string; validator_user_id: string }): Promise<"validator" | "plant_manager"> {
    if (user.id === p.validator_user_id) throw new HttpError(403, "The accused validator cannot sign");
    const signed = await this.db.query<{ user_id: string; capacity: string }>("SELECT user_id, capacity FROM slash_signatures WHERE proposal_id = $1", [p.id]);
    if (signed.rows.some((r) => r.user_id === user.id)) throw new HttpError(409, "You already signed this proposal");
    const validators = signed.rows.filter((r) => r.capacity === "validator").length;
    const hasPm = signed.rows.some((r) => r.capacity === "plant_manager");
    const isPm = roles.includes("plant_manager");
    const isVal = (await this.isValidator(siteId, user)).ok;
    if (isVal && validators < 2 && (!isPm || hasPm)) return "validator";
    if (isPm && !hasPm) return "plant_manager";
    if (isVal && validators < 2) return "validator";
    throw new HttpError(403, "This proposal needs two active validators and one plant manager, other than the accused");
  }
  async slashRequest(siteId: string, user: User, roles: Role[], id: string) {
    const p = await this.proposal(siteId, id);
    const cap = await this.capacityOf(siteId, user, roles, p);
    return this.sigs.request(user, {
      action: "validator.slash",
      entity: this.slashEntity(p),
      meaning: `Slash ${p.validator_address} by ${p.amount} units (as ${cap === "plant_manager" ? "plant manager" : "validator"})`,
      comment: "",
      site: siteId,
      ...this.contractDomain(true),
    });
  }
  async signSlash(siteId: string, user: User, roles: Role[], id: string, proof: { nonce: string; signature: Hex }) {
    const p = await this.proposal(siteId, id);
    const cap = await this.capacityOf(siteId, user, roles, p);
    await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "validator.slash", entity: this.slashEntity(p) }, proof);
      await q.query("INSERT INTO slash_signatures (proposal_id, user_id, address, signature_id, capacity) VALUES ($1,$2,$3,$4,$5)", [id, user.id, user.address, s.id, cap]);
    });
    await this.rec.event(`user:${user.address}`, "validator.slash_signed", id, { site: siteId, capacity: cap });
    const rows = await this.db.query<{ capacity: string; typed_data: string; signature: string }>(
      "SELECT ss.capacity, s.typed_data, s.signature FROM slash_signatures ss JOIN signatures s ON s.id = ss.signature_id WHERE ss.proposal_id = $1 ORDER BY ss.created_at",
      [id],
    );
    const vals = rows.rows.filter((r) => r.capacity === "validator");
    const pm = rows.rows.find((r) => r.capacity === "plant_manager");
    if (vals.length >= 2 && pm) {
      const sigs = [vals[0]!, vals[1]!, pm].map((r) => sigArg(JSON.parse(r.typed_data), r.signature)) as [ReturnType<typeof sigArg>, ReturnType<typeof sigArg>, ReturnType<typeof sigArg>];
      const relay = await this.relay(siteId, "slash", id, { sigs }, () => this.chain!.slash(siteId, p.validator_address, BigInt(p.amount), id, sigs));
      if (relay.status === "done") {
        await this.db.query("UPDATE slash_proposals SET status = 'executed', executed_at = now() WHERE id = $1", [id]);
        await this.rec.decide(siteId, { agent: "system:relayer", kind: "validator.slashed", summary: `Slashed ${p.validator_address} by ${p.amount} units into the quality fund`, data: { proposalId: id, txHash: relay.txHash } });
      }
    }
  }
}
