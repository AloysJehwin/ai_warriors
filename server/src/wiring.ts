import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { geminiProvider, OfflineLlm, openAiCompatProvider, type LlmProvider } from "./adapters/llm.js";
import { LocalSignedAnchor, MockPayments, type AnchorAdapter, type PaymentRail } from "./adapters/rails.js";
import { Agents } from "./agents/agents.js";
import { Auth, Signatures } from "./auth/auth.js";
import { Inbox } from "./core/inbox.js";
import { Monitor } from "./core/monitor.js";
import { Proof } from "./core/proof.js";
import { Recorder } from "./core/recorder.js";
import { Templates } from "./core/templates.js";
import { Validation } from "./core/validation.js";
import { migrate, openDb, type Db } from "./db/db.js";
import { LedgerStore } from "./db/ledger-store.js";
import { loadPolicy } from "./domain/policy.js";
import { RunEngine } from "./pipelines/engine.js";
import { PlantService } from "./plant/plant.js";

export interface RailStatus {
  rail: string;
  mode: string;
  live: boolean;
}

export interface System {
  cfg: Config;
  db: Db;
  rails: RailStatus[];
  warnings: string[];
  policy: ReturnType<typeof loadPolicy>;
  ledger: LedgerStore;
  rec: Recorder;
  auth: Auth;
  sigs: Signatures;
  plant: PlantService;
  templates: Templates;
  engine: RunEngine;
  inbox: Inbox;
  monitor: Monitor;
  proof: Proof;
  validation: Validation;
  agents: Agents;
  payments: PaymentRail;
  ensNames: { lookup(addresses: string[]): Promise<Record<string, string | null>> } | null;
  policyCheck?: () => Promise<{ ok: boolean; detail: string }>;
  /** One engine cycle: pull data, advance runs, watch for anomalies, anchor. Throttled and lease-guarded. */
  advance(force?: boolean): Promise<void>;
  close(): Promise<void>;
}

export async function buildSystem(cfg: Config, opts: { now?: () => number; policyText?: string; llm?: LlmProvider } = {}): Promise<System> {
  const warnings: string[] = [];
  if (cfg.VERCEL && !cfg.DATABASE_URL) throw new Error("On Vercel, DATABASE_URL is required (add Neon from the Vercel Marketplace)");
  const now = opts.now ?? Date.now;
  const db = await openDb({ url: cfg.DATABASE_URL, dataDir: cfg.DATA_DIR });
  await migrate(db);
  const policy = loadPolicy(opts.policyText ?? readFileSync(resolve(cfg.POLICY_FILE), "utf8"));

  // ---- LLM ----
  let llm: LlmProvider = opts.llm ?? new OfflineLlm();
  if (!opts.llm && cfg.LLM_PROVIDER === "gemini") {
    if (cfg.GEMINI_API_KEY) llm = await geminiProvider(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL, cfg.LLM_TIMEOUT_MS);
    else warnings.push("LLM_PROVIDER=gemini but GEMINI_API_KEY is missing; agents use their deterministic offline reasoning");
  } else if (!opts.llm && cfg.LLM_PROVIDER === "openai_compat") {
    if (cfg.OPENAI_COMPAT_BASE_URL && cfg.OPENAI_COMPAT_MODEL)
      llm = openAiCompatProvider({
        name: "openai-compat",
        baseUrl: cfg.OPENAI_COMPAT_BASE_URL,
        model: cfg.OPENAI_COMPAT_MODEL,
        timeoutMs: cfg.LLM_TIMEOUT_MS,
        headers: async (): Promise<Record<string, string>> => (cfg.OPENAI_COMPAT_API_KEY ? { authorization: `Bearer ${cfg.OPENAI_COMPAT_API_KEY}` } : {}),
      });
    else warnings.push("openai_compat needs OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODEL; agents use offline reasoning");
  } else if (!opts.llm && cfg.LLM_PROVIDER === "0g") {
    const { zeroGComputeProvider } = await import("./chain/zerog.js");
    llm = await zeroGComputeProvider(cfg).catch((e) => {
      warnings.push(`0G Compute unavailable (${e instanceof Error ? e.message : e}); agents use offline reasoning`);
      return new OfflineLlm();
    });
  }

  // ---- Proof rails ----
  let anchor: AnchorAdapter = new LocalSignedAnchor(cfg.LEDGER_SIGNING_KEY);
  if (anchor instanceof LocalSignedAnchor && anchor.ephemeral)
    warnings.push(cfg.VERCEL ? "LEDGER_SIGNING_KEY not set: each serverless instance signs with a different key." : "LEDGER_SIGNING_KEY not set; checkpoints use a key that changes on restart");
  let payments: PaymentRail = new MockPayments();
  let policyCheck: System["policyCheck"];
  if (cfg.ANCHOR === "hedera" || cfg.PAYMENTS === "hedera") {
    try {
      const h = await import("./chain/hedera.js");
      const hedera = h.hederaFromConfig(cfg);
      if (cfg.ANCHOR === "hedera") anchor = hedera.anchor();
      if (cfg.PAYMENTS === "hedera") payments = hedera.payments();
      policyCheck = hedera.policyRegistryCheck(policy.policy.id, policy.hash);
    } catch (e) {
      warnings.push(`Hedera not configured (${e instanceof Error ? e.message : e}); using the local signed anchor`);
    }
  }
  let ensNames: System["ensNames"] = null;
  if (cfg.IDENTITY === "ens") {
    const { EnsNames } = await import("./chain/ens.js");
    ensNames = new EnsNames(cfg.ENS_RPC_URL);
  }

  const ledger = new LedgerStore(db);
  const rec = new Recorder(db, ledger);
  const auth = new Auth(db, { sessionTtlMs: cfg.SESSION_TTL_HOURS * 3_600_000, rpcUrl: cfg.AUTH_RPC_URL, bootstrapAdmin: cfg.BOOTSTRAP_ADMIN_ADDRESS });
  const sigs = new Signatures(db, cfg.AUTH_RPC_URL);
  const plant = new PlantService(db, now);
  const templates = new Templates(db, rec);
  await templates.ensureLibrary();
  const engine = new RunEngine(db, plant, templates, rec, now);
  const inbox = new Inbox(db, rec, sigs, engine, plant, templates, cfg.SIGNATURE_CHAIN_ID);
  engine.inbox = inbox;
  const agents = new Agents(llm);
  const monitor = new Monitor(db, plant, agents, inbox, rec, policy, now);
  const proof = new Proof(db, ledger, anchor);
  const validation = new Validation(db, rec, ledger, sigs, engine, inbox, cfg.SIGNATURE_CHAIN_ID);

  const advance = async (force = false) => {
    // throttle: one cycle per 4 s across all instances (the lease is left to expire, not released)
    if (!force && !(await plant.tryLease("advance", 4_000))) return;
    await plant.ingest();
    await engine.tick();
    const sites = await db.query<{ id: string }>("SELECT id FROM sites");
    for (const s of sites.rows) await monitor.scan(s.id);
    const head = await ledger.head();
    const last = (await proof.anchors(1))[0];
    if (head && (!last || head.seq - last.toSeq >= cfg.ANCHOR_EVERY || (head.seq > last.toSeq && now() - Date.parse(last.ts) > 30 * 60_000))) await proof.anchorHead(null, null).catch((e) => console.error("[ordo] anchor", e));
  };

  const rails: RailStatus[] = [
    { rail: "database", mode: db.kind === "postgres" ? "postgres" : cfg.DATA_DIR === "memory" ? "pglite (memory)" : "pglite (disk)", live: db.kind === "postgres" },
    { rail: "identity", mode: `SIWE wallet sign-in${ensNames ? " + ENS names" : ""}`, live: true },
    { rail: "signatures", mode: "EIP-712 typed data", live: true },
    { rail: "ai", mode: llm.name === "gemini" ? `gemini:${cfg.GEMINI_MODEL}` : llm.name, live: llm.name !== "offline" },
    { rail: "anchor", mode: anchor.kind, live: anchor.kind !== "local-signed" },
    { rail: "payments", mode: payments.kind, live: payments.kind !== "mock" },
    { rail: "policy registry", mode: policyCheck ? "OrdoPolicyRegistry" : "hash only", live: Boolean(policyCheck) },
  ];

  return {
    cfg,
    db,
    rails,
    warnings,
    policy,
    ledger,
    rec,
    auth,
    sigs,
    plant,
    templates,
    engine,
    inbox,
    monitor,
    proof,
    validation,
    agents,
    payments,
    ensNames,
    policyCheck,
    advance,
    close: () => db.close(),
  };
}
