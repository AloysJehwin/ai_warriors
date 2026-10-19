import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { geminiProvider, OfflineLlm, openAiCompatProvider, type LlmProvider } from "./adapters/llm.js";
import {
  InAppApprovals,
  LocalEvidenceStore,
  LocalSignedAnchor,
  MockPayments,
  PlainIdentity,
  type AnchorAdapter,
  type ApprovalRail,
  type EvidenceStore,
  type IdentityResolver,
  type PaymentRail,
} from "./adapters/rails.js";
import { Agents } from "./agents/agents.js";
import { migrate, openDb, type Db } from "./db/db.js";
import { LedgerStore } from "./db/ledger-store.js";
import { SimStore } from "./db/sim-store.js";
import { Store } from "./db/store.js";
import { loadPolicy } from "./domain/policy.js";
import { Orchestrator } from "./engine/orchestrator.js";

export interface RailStatus {
  rail: string;
  mode: string;
  live: boolean;
}
export interface System {
  db: Db;
  rails: RailStatus[];
  ledger: LedgerStore;
  store: Store;
  orchestrator: Orchestrator;
  /** A second orchestrator over the same database — what another serverless instance would be. */
  spawn(): Orchestrator;
  policy: ReturnType<typeof loadPolicy>;
  warnings: string[];
  close(): Promise<void>;
}

export async function buildSystem(cfg: Config, opts: { now?: () => number; policyText?: string } = {}): Promise<System> {
  const warnings: string[] = [];
  if (cfg.VERCEL && !cfg.DATABASE_URL) throw new Error("On Vercel, DATABASE_URL is required (add Neon from the Vercel Marketplace)");
  const db = await openDb({ url: cfg.DATABASE_URL, dataDir: cfg.DATA_DIR });
  await migrate(db);
  const policy = loadPolicy(opts.policyText ?? readFileSync(resolve(cfg.POLICY_FILE), "utf8"));

  // ---- LLM ----
  let llm: LlmProvider = new OfflineLlm();
  if (cfg.LLM_PROVIDER === "gemini") {
    if (cfg.GEMINI_API_KEY) llm = await geminiProvider(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL, cfg.LLM_TIMEOUT_MS);
    else warnings.push("LLM_PROVIDER=gemini but GEMINI_API_KEY is missing; using offline agents");
  } else if (cfg.LLM_PROVIDER === "openai_compat") {
    if (cfg.OPENAI_COMPAT_BASE_URL && cfg.OPENAI_COMPAT_MODEL)
      llm = openAiCompatProvider({
        name: "openai-compat",
        baseUrl: cfg.OPENAI_COMPAT_BASE_URL,
        model: cfg.OPENAI_COMPAT_MODEL,
        timeoutMs: cfg.LLM_TIMEOUT_MS,
        headers: async (): Promise<Record<string, string>> => (cfg.OPENAI_COMPAT_API_KEY ? { authorization: `Bearer ${cfg.OPENAI_COMPAT_API_KEY}` } : {}),
      });
    else warnings.push("openai_compat needs OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODEL; using offline agents");
  } else if (cfg.LLM_PROVIDER === "0g") {
    const { zeroGComputeProvider } = await import("./chain/zerog.js");
    llm = await zeroGComputeProvider(cfg).catch((e) => {
      warnings.push(`0G Compute unavailable (${e instanceof Error ? e.message : e}); using offline agents`);
      return new OfflineLlm();
    });
  }

  // ---- Rails ----
  let anchor: AnchorAdapter = new LocalSignedAnchor(cfg.LEDGER_SIGNING_KEY);
  if (anchor instanceof LocalSignedAnchor && anchor.ephemeral)
    warnings.push(cfg.VERCEL ? "LEDGER_SIGNING_KEY not set: each serverless instance signs with a different key. Set it in Vercel env." : "LEDGER_SIGNING_KEY not set; checkpoints use a key that changes on restart");
  let approvals: ApprovalRail = new InAppApprovals();
  let payments: PaymentRail = new MockPayments();
  let identity: IdentityResolver = new PlainIdentity();
  const evidenceDir = cfg.VERCEL ? "/tmp/ordo-evidence" : `${cfg.DATA_DIR === "memory" ? ".data" : cfg.DATA_DIR}/evidence`;
  let evidence: EvidenceStore = new LocalEvidenceStore(evidenceDir);
  let policyCheck: (() => Promise<{ ok: boolean; detail: string }>) | undefined;

  if (cfg.ANCHOR === "hedera" || cfg.APPROVALS === "hedera" || cfg.PAYMENTS === "hedera") {
    const h = await import("./chain/hedera.js");
    const hedera = h.hederaFromConfig(cfg);
    if (cfg.ANCHOR === "hedera") anchor = hedera.anchor();
    if (cfg.APPROVALS === "hedera") approvals = hedera.approvals();
    if (cfg.PAYMENTS === "hedera") payments = hedera.payments();
    policyCheck = hedera.policyRegistryCheck(policy.hash);
  }
  if (cfg.IDENTITY === "ens") {
    const { EnsIdentity } = await import("./chain/ens.js");
    identity = new EnsIdentity(cfg);
  }
  if (cfg.EVIDENCE_STORE === "0g") {
    const { ZeroGStorage } = await import("./chain/zerog.js");
    evidence = new ZeroGStorage(cfg);
  }

  const ledger = new LedgerStore(db);
  const store = new Store(db);
  const deps: ConstructorParameters<typeof Orchestrator>[0] = {
    ledger,
    store,
    sim: new SimStore(db),
    agents: new Agents(llm),
    llmName: llm.name === "gemini" ? `gemini:${cfg.GEMINI_MODEL}` : llm.name,
    anchor,
    approvals,
    payments,
    identity,
    evidence,
    policy: policy.policy,
    policyHash: policy.hash,
    policyCheck,
    seed: cfg.SIM_SEED,
    scenario: cfg.SIM_SCENARIO,
    tickMs: cfg.TICK_MS,
    autonomy: cfg.LINE_AUTONOMY,
    autostart: cfg.SIM_AUTOSTART,
    now: opts.now,
  };
  const orchestrator = new Orchestrator(deps);
  await orchestrator.init();

  const rails: RailStatus[] = [
    { rail: "database", mode: db.kind === "postgres" ? "postgres" : cfg.DATA_DIR === "memory" ? "pglite (memory)" : "pglite (disk)", live: db.kind === "postgres" },
    { rail: "ai", mode: llm.name === "gemini" ? `gemini:${cfg.GEMINI_MODEL}` : llm.name, live: llm.name !== "offline" },
    { rail: "anchor", mode: anchor.kind, live: anchor.kind !== "local-signed" },
    { rail: "approvals", mode: approvals.kind, live: approvals.kind !== "in-app" },
    { rail: "payments", mode: payments.kind, live: payments.kind !== "mock" },
    { rail: "identity", mode: identity.kind, live: identity.kind !== "plain" },
    { rail: "evidence", mode: evidence.kind, live: evidence.kind !== "local" },
    { rail: "policy registry", mode: policyCheck ? "OrdoPolicyRegistry" : "hash only", live: Boolean(policyCheck) },
  ];

  return {
    db,
    rails,
    ledger,
    store,
    orchestrator,
    spawn: () => new Orchestrator(deps),
    policy,
    warnings,
    close: async () => {
      await db.close();
    },
  };
}
