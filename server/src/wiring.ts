import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { publicBase, type Config } from "./config.js";
import { geminiProvider, OfflineLlm, openAiCompatProvider, type LlmProvider } from "./adapters/llm.js";
import { LocalSignedAnchor, type AnchorAdapter } from "./adapters/rails.js";
import { Agents } from "./agents/agents.js";
import { Auth, Signatures } from "./auth/auth.js";
import { Assessments } from "./core/assessments.js";
import { AgentNfts } from "./core/agent-nfts.js";
import { Autonomy } from "./core/autonomy.js";
import { Inbox } from "./core/inbox.js";
import { Jobs } from "./core/jobs.js";
import { Monitor } from "./core/monitor.js";
import { Names } from "./core/names.js";
import { Openings } from "./core/openings.js";
import { Passports } from "./core/passports.js";
import { Proof } from "./core/proof.js";
import { Recorder } from "./core/recorder.js";
import { Replicas } from "./core/replicas.js";
import { Templates } from "./core/templates.js";
import { Validation } from "./core/validation.js";
import { WorkOrders } from "./core/workorders.js";
import { Schedules, type ScheduleRail } from "./core/schedules.js";
import { Trust } from "./core/trust.js";
import { EvmAgentPayer, type AgentPayer } from "./chain/agent.js";
import { TrustChain } from "./chain/trust.js";
import type { Hex, Transport } from "viem";
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
  trust: Trust;
  agents: Agents;
  workOrders: WorkOrders;
  /** Deadlines on Hedera's Schedule Service, when the operator is configured */
  schedules: Schedules | null;
  autonomy: Autonomy;
  passports: Passports;
  openings: Openings;
  jobs: Jobs;
  names: Names;
  agentNfts: AgentNfts;
  /** x402: the paid assessment route's middleware and terms, when Ordo sells assessments */
  x402: { middleware: import("hono").MiddlewareHandler; terms: { network: string; payTo: string; price: string; asset: string } } | null;
  ensNames: { lookup(addresses: string[]): Promise<Record<string, string | null>> } | null;
  /** One engine cycle: pull data, advance runs, watch for anomalies, refund expired escrows, anchor. Throttled and lease-guarded. */
  advance(force?: boolean): Promise<void>;
  close(): Promise<void>;
}

export async function buildSystem(cfg: Config, opts: { now?: () => number; policyText?: string; llm?: LlmProvider; trustTransport?: Transport; x402Facilitator?: import("@x402/core/server").FacilitatorClient; x402Fetch?: typeof fetch; ensTransport?: Transport; blobStore?: import("./chain/zerog.js").BlobStore; inftTransport?: Transport; scheduler?: ScheduleRail } = {}): Promise<System> {
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
  let hedera: Awaited<ReturnType<typeof import("./chain/hedera.js")["hederaFromConfig"]>> | null = null;
  if (cfg.ANCHOR === "hedera" || cfg.HEDERA_PASSPORT_TOKEN_ID || (cfg.HEDERA_SCHEDULES === "on" && cfg.HEDERA_OPERATOR_ID && cfg.HEDERA_OPERATOR_KEY)) {
    try {
      const h = await import("./chain/hedera.js");
      hedera = h.hederaFromConfig(cfg);
      if (cfg.ANCHOR === "hedera") anchor = hedera.anchor();
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
  const jobs = new Jobs(db, now);
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
  let trustChain: TrustChain | null = null;
  if (cfg.TRUST_CONTRACT_ADDRESS && cfg.TRUST_RELAYER_KEY && cfg.TRUST_CHAIN_ID && (cfg.TRUST_RPC_URL || opts.trustTransport)) {
    trustChain = new TrustChain(
      {
        chainId: cfg.TRUST_CHAIN_ID,
        name: cfg.TRUST_CHAIN_NAME,
        rpcUrl: cfg.TRUST_RPC_URL ?? "http://in-process",
        explorerUrl: cfg.TRUST_EXPLORER_URL ?? null,
        address: cfg.TRUST_CONTRACT_ADDRESS as `0x${string}`,
        workOrders: (cfg.TRUST_WORKORDERS_ADDRESS as `0x${string}` | undefined) ?? null,
        policies: (cfg.TRUST_POLICIES_ADDRESS as `0x${string}` | undefined) ?? null,
        relayerKey: cfg.TRUST_RELAYER_KEY as `0x${string}`,
        symbol: cfg.TRUST_SYMBOL,
        decimals: cfg.TRUST_DECIMALS,
      },
      opts.trustTransport,
    );
  } else if (cfg.TRUST_CONTRACT_ADDRESS || cfg.TRUST_RELAYER_KEY) {
    warnings.push("OrdoTrust needs TRUST_CONTRACT_ADDRESS, TRUST_RELAYER_KEY, TRUST_CHAIN_ID and TRUST_RPC_URL together; validator stakes are off");
  }
  const trust = new Trust(db, rec, sigs, trustChain, cfg.SIGNATURE_CHAIN_ID);
  inbox.trust = trust;
  const validation = new Validation(db, rec, ledger, sigs, engine, inbox, cfg.SIGNATURE_CHAIN_ID, trust);
  // ---- Evidence copies on 0G Storage ----
  if (opts.blobStore || cfg.EVIDENCE_STORE === "0g") {
    try {
      const store = opts.blobStore ?? new (await import("./chain/zerog.js")).ZeroGStorage(cfg);
      validation.replicas = new Replicas(db, jobs, rec, store);
    } catch (e) {
      warnings.push(`0G Storage unusable (${e instanceof Error ? e.message : e}); evidence stays in the database only`);
    }
  }

  // ---- The maintenance agent's own account: it escrows vendor payments in OrdoWorkOrders ----
  let payer: AgentPayer | null = null;
  // the Agent Kit policy reads work orders, which need the payer: bind it late
  const checkEscrow = (p: { siteId: string; workOrderId: string; vendor: string; amount: string }) => workOrders.checkEscrow(p);
  if (trustChain && cfg.TRUST_WORKORDERS_ADDRESS && cfg.HEDERA_AGENT_KEY) {
    try {
      const onHedera = [295, 296, 297].includes(trustChain.cfg.chainId);
      if (onHedera && cfg.HEDERA_AGENT_ID) {
        const { HederaAgentKitPayer } = await import("./chain/agent-kit.js");
        payer = new HederaAgentKitPayer({
          network: cfg.HEDERA_NETWORK,
          agentId: cfg.HEDERA_AGENT_ID,
          agentKey: cfg.HEDERA_AGENT_KEY,
          workOrders: cfg.TRUST_WORKORDERS_ADDRESS as Hex,
          check: checkEscrow,
          audit: hedera && cfg.HEDERA_TOPIC_ID ? { topicId: cfg.HEDERA_TOPIC_ID, client: hedera.client } : undefined,
        });
      } else {
        const raw = cfg.HEDERA_AGENT_KEY.trim();
        const key = /^(0x)?[0-9a-fA-F]{64}$/.test(raw) ? raw.replace(/^(0x)?/, "0x") : `0x${(await import("./chain/hedera.js")).parseHederaKey(raw).toStringRaw()}`;
        payer = new EvmAgentPayer({ ...trustChain.cfg, workOrders: cfg.TRUST_WORKORDERS_ADDRESS as Hex }, key as Hex, opts.trustTransport);
      }
    } catch (e) {
      warnings.push(`Agent account unusable (${e instanceof Error ? e.message : e}); work orders assign vendors without escrow`);
    }
  } else if (cfg.TRUST_WORKORDERS_ADDRESS && !cfg.HEDERA_AGENT_KEY) {
    warnings.push("TRUST_WORKORDERS_ADDRESS is set but HEDERA_AGENT_KEY is not: work orders assign vendors without escrow");
  }
  const workOrders = new WorkOrders(db, rec, sigs, trust, payer, now);
  inbox.workOrders = workOrders;
  // ---- Deadlines on Hedera's Schedule Service: escrow refunds, validator payouts, stage timeouts ----
  let schedules: Schedules | null = null;
  const scheduleRail = opts.scheduler ?? (hedera && cfg.HEDERA_SCHEDULES === "on" ? hedera.scheduler() : null);
  if (scheduleRail) {
    // contract calls are scheduled only on a trust chain on Hedera itself
    const onHedera = Boolean(opts.scheduler || (trustChain && [295, 296, 297].includes(trustChain.cfg.chainId)));
    schedules = new Schedules(db, rec, scheduleRail, () => (onHedera ? trust.chain : null), now);
    workOrders.schedules = schedules;
    trust.schedules = schedules;
    if (cfg.HEDERA_TOPIC_ID || opts.scheduler) engine.timeouts = schedules;
  }
  const autonomy = new Autonomy(db, rec, sigs, plant, trust, policy, cfg.SIGNATURE_CHAIN_ID);
  let passportRail: import("./chain/passport.js").PassportRail | null = null;
  if (cfg.HEDERA_PASSPORT_TOKEN_ID && hedera) passportRail = (await import("./chain/passport.js")).hederaPassports(hedera.client, cfg.HEDERA_NETWORK, cfg.HEDERA_PASSPORT_TOKEN_ID);
  if (cfg.HEDERA_PASSPORT_TOKEN_ID && !publicBase(cfg)) warnings.push("Set PUBLIC_URL so lot passport NFTs point at a public page");
  // ---- x402: Ordo sells vibration assessments per call; the agent buys one for each work order ----
  let x402: System["x402"] = null;
  const x402Net = (await import("./chain/x402.js")).x402Network(cfg.HEDERA_NETWORK);
  const payTo = cfg.X402_PAY_TO ?? cfg.HEDERA_OPERATOR_ID;
  if (x402Net && payTo) {
    const { x402Seller } = await import("./chain/x402.js");
    x402 = x402Seller({ network: x402Net, payTo, price: cfg.X402_PRICE_TINYBARS, facilitatorUrl: cfg.X402_FACILITATOR_URL, facilitator: opts.x402Facilitator });
  }
  const assessUrl = cfg.X402_ASSESSMENT_URL ?? (x402 && publicBase(cfg) ? `${publicBase(cfg)}${(await import("./chain/x402.js")).ASSESSMENT_PATH}` : null);
  if (x402Net && cfg.HEDERA_AGENT_ID && cfg.HEDERA_AGENT_KEY && assessUrl) {
    try {
      const { X402Buyer } = await import("./chain/x402.js");
      const buyer = new X402Buyer({ network: x402Net, agentId: cfg.HEDERA_AGENT_ID, agentKey: cfg.HEDERA_AGENT_KEY, maxPerCall: cfg.X402_MAX_TINYBARS }, opts.x402Fetch);
      workOrders.assessments = new Assessments(jobs, plant, rec, buyer, assessUrl);
    } catch (e) {
      warnings.push(`x402 buyer unusable (${e instanceof Error ? e.message : e}); work orders open without an assessment`);
    }
  }

  const passports = new Passports(db, rec, sigs, engine, trust, proof, passportRail, publicBase(cfg), cfg.SIGNATURE_CHAIN_ID, now);

  // ---- ENSv2 names on Sepolia for the site, its people, assets and agents ----
  let nameRail: import("./core/names.js").NameRail | null = null;
  const ensParts = [cfg.ENS_PARENT_NAME, cfg.ENS_REGISTRY_ADDRESS, cfg.ENS_RESOLVER_ADDRESS, cfg.ENS_OWNER_KEY];
  if (ensParts.every(Boolean)) {
    const { EnsV2 } = await import("./chain/ensv2.js");
    nameRail = new EnsV2(
      {
        rpcUrl: cfg.ENS_SEPOLIA_RPC_URL,
        ownerKey: cfg.ENS_OWNER_KEY!.replace(/^(0x)?/, "0x") as Hex,
        parentName: cfg.ENS_PARENT_NAME!,
        parentRegistry: cfg.ENS_REGISTRY_ADDRESS as Hex,
        resolver: cfg.ENS_RESOLVER_ADDRESS as Hex,
        factory: cfg.ENS_FACTORY_ADDRESS as Hex | undefined,
        userRegistryImpl: cfg.ENS_USER_REGISTRY_IMPL as Hex | undefined,
        chainId: cfg.ENS_CHAIN_ID,
      },
      opts.ensTransport,
    );
  } else if (ensParts.some(Boolean)) {
    warnings.push("ENS names need ENS_PARENT_NAME, ENS_REGISTRY_ADDRESS, ENS_RESOLVER_ADDRESS and ENS_OWNER_KEY together");
  }
  const names = new Names(db, rec, nameRail, publicBase(cfg), () => payer?.address ?? null, now);

  // ---- Agents as ERC-7857 iNFTs on 0G ----
  let inftRail: import("./core/agent-nfts.js").AgentNftRail | null = null;
  if (cfg.ZG_INFT_ADDRESS && cfg.ZG_PRIVATE_KEY) {
    const { AgentNftChain } = await import("./chain/inft.js");
    inftRail = new AgentNftChain({ rpcUrl: cfg.ZG_RPC_URL, chainId: cfg.ZG_CHAIN_ID, address: cfg.ZG_INFT_ADDRESS as Hex, key: cfg.ZG_PRIVATE_KEY.replace(/^(0x)?/, "0x") as Hex }, opts.inftTransport);
  } else if (cfg.ZG_INFT_ADDRESS) {
    warnings.push("ZG_INFT_ADDRESS is set but ZG_PRIVATE_KEY is not: agents are not minted as iNFTs");
  }
  const agentNfts = new AgentNfts(db, rec, inftRail, policy.hash, () => (llm.name === "gemini" ? `gemini:${cfg.GEMINI_MODEL}` : llm.name), now);
  passports.names = names;
  const openings = new Openings(db, engine);

  const advance = async (force = false) => {
    // throttle: one cycle per 4 s across all instances (the lease is left to expire, not released)
    if (!force && !(await plant.tryLease("advance", 4_000))) return;
    await plant.ingest();
    await engine.tick();
    const sites = await db.query<{ id: string }>("SELECT id FROM sites");
    for (const s of sites.rows) await monitor.scan(s.id);
    await schedules?.reconcile();
    await workOrders.refundExpired().catch((e) => console.error("[ordo] refunds", e));
    await passports.reconcile().catch((e) => console.error("[ordo] passports", e));
    await jobs.run().catch((e) => console.error("[ordo] jobs", e));
    await names.reconcile().catch((e) => console.error("[ordo] ens", e));
    await agentNfts.reconcile().catch((e) => console.error("[ordo] inft", e));
    const head = await ledger.head();
    const last = (await proof.anchors(1))[0];
    if (head && (!last || head.seq - last.toSeq >= cfg.ANCHOR_EVERY || (head.seq > last.toSeq && now() - Date.parse(last.ts) > 30 * 60_000))) await proof.anchorHead(null, null).catch((e) => console.error("[ordo] anchor", e));
  };

  const rails: RailStatus[] = [
    { rail: "database", mode: db.kind === "postgres" ? "postgres" : cfg.DATA_DIR === "memory" ? "pglite (memory)" : "pglite (disk)", live: db.kind === "postgres" },
    { rail: "identity", mode: `SIWE wallet sign-in${ensNames ? " + ENS primary names" : ""}`, live: true },
    { rail: "ens names", mode: nameRail ? `ENSv2 on Sepolia under ${cfg.ENS_PARENT_NAME}` : "off: no names issued", live: Boolean(nameRail) },
    { rail: "signatures", mode: "EIP-712 typed data", live: true },
    { rail: "trust contract", mode: trustChain ? `OrdoTrust ${cfg.TRUST_CONTRACT_ADDRESS} · ${cfg.TRUST_CHAIN_NAME} (${cfg.TRUST_CHAIN_ID})` : "off: validators approved in-app, no stakes", live: Boolean(trustChain) },
    { rail: "ai", mode: llm.name === "gemini" ? `gemini:${cfg.GEMINI_MODEL}` : llm.name, live: llm.name !== "offline" },
    { rail: "anchor", mode: anchor.kind, live: anchor.kind !== "local-signed" },
    {
      rail: "agent payments",
      mode: workOrders.live ? `${payer!.kind === "hedera-agent-kit" ? "Hedera Agent Kit" : "agent key"} → OrdoWorkOrders ${cfg.TRUST_WORKORDERS_ADDRESS}` : "off: work orders assign a vendor, no escrow",
      live: workOrders.live,
    },
    { rail: "evidence copies", mode: validation.replicas ? `${validation.replicas.store.kind}, encrypted · ${cfg.ZG_INDEXER_URL}` : "database only", live: Boolean(validation.replicas) },
    { rail: "agent iNFTs", mode: inftRail ? `ERC-7857 OrdoAgentNFT ${cfg.ZG_INFT_ADDRESS} · 0G (${cfg.ZG_CHAIN_ID})` : "off", live: Boolean(inftRail) },
    { rail: "lot passports", mode: passportRail ? `HTS NFT ${passportRail.tokenId}` : "in-app passports, no NFT", live: Boolean(passportRail) },
    {
      rail: "x402 assessments",
      mode: [x402 ? `sells at ${Number(cfg.X402_PRICE_TINYBARS) / 1e8} HBAR to ${x402.terms.payTo}` : null, workOrders.assessments ? "agent buys one per work order" : null].filter(Boolean).join(" · ") || "off",
      live: Boolean(x402 && workOrders.assessments),
    },
    {
      rail: "hedera schedules",
      mode: schedules ? [trustChain && (opts.scheduler || [295, 296, 297].includes(trustChain.cfg.chainId)) ? "escrow refunds · validator payouts" : null, engine.timeouts ? "stage timeouts" : null].filter(Boolean).join(" · ") || "on, nothing to schedule" : "off: the server runs deadlines",
      live: Boolean(schedules),
    },
    { rail: "autonomy policies", mode: trustChain?.cfg.policies ? `OrdoPolicies ${cfg.TRUST_POLICIES_ADDRESS}` : "in-app signatures", live: Boolean(trustChain?.cfg.policies) },
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
    trust,
    agents,
    workOrders,
    schedules,
    autonomy,
    passports,
    openings,
    jobs,
    names,
    agentNfts,
    x402,
    ensNames,
    advance,
    close: () => db.close(),
  };
}
