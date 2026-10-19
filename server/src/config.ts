import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default(".data"),
  POLICY_FILE: z.string().default("../policies/default.yaml"),
  WEB_DIST: z.string().default("../web/dist"),
  CORS_ORIGINS: z.string().default(""),
  /** Run a background timer that advances ingestion and runs. Off on serverless (requests drive it). */
  ENGINE_TIMER: z.enum(["auto", "on", "off"]).default("auto"),
  TICK_MS: z.coerce.number().int().min(1000).default(5000),
  VERCEL: z.string().optional(),
  VERCEL_ENV: z.string().optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  /** Vercel sets this to the production domain; public links (lot passports, QR codes) use it when PUBLIC_URL is unset */
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
  /** Base URL people and wallets reach this deployment at, e.g. https://aiwarriors.vercel.app */
  PUBLIC_URL: z.string().url().optional(),

  // ---- Accounts ----
  SESSION_TTL_HOURS: z.coerce.number().min(1).max(24 * 30).default(72),
  /** When set, only this wallet may create sites. Otherwise any signed-in wallet can create its own site. */
  BOOTSTRAP_ADMIN_ADDRESS: z.string().optional(),
  /** RPC used to verify smart-contract wallets (ERC-1271 / ERC-6492). Optional. */
  AUTH_RPC_URL: z.string().optional(),
  /** Chain id put in EIP-712 signatures when the client does not send its own. */
  SIGNATURE_CHAIN_ID: z.coerce.number().int().default(296),

  // ---- On-chain trust (OrdoTrust: role credentials, validator stakes, releases, slashing) ----
  /** JSON-RPC of the chain OrdoTrust is deployed on, e.g. https://testnet.hashio.io/api for Hedera testnet */
  TRUST_RPC_URL: z.string().optional(),
  TRUST_CHAIN_ID: z.coerce.number().int().optional(),
  TRUST_CHAIN_NAME: z.string().default("Hedera Testnet"),
  TRUST_EXPLORER_URL: z.string().optional(),
  TRUST_CONTRACT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Pays gas to relay signed grants, releases and slashes. Holds no authority: the contract checks the signers. */
  TRUST_RELAYER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  TRUST_SYMBOL: z.string().default("HBAR"),
  /** decimals of native value inside the contract: 8 on Hedera (tinybars), 18 on other EVM chains */
  TRUST_DECIMALS: z.coerce.number().int().min(0).max(18).default(8),
  /** OrdoWorkOrders: the maintenance agent escrows vendor payments within caps an admin signed */
  TRUST_WORKORDERS_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** OrdoPolicies: raising a line's autonomy needs two plant managers' signatures */
  TRUST_POLICIES_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),

  // ---- Agents ----
  LLM_PROVIDER: z.enum(["offline", "gemini", "openai_compat", "0g"]).default("offline"),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(15000),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  OPENAI_COMPAT_BASE_URL: z.string().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  OPENAI_COMPAT_MODEL: z.string().optional(),

  // ---- Proof ----
  ANCHOR: z.enum(["local", "hedera"]).default("local"),
  LEDGER_SIGNING_KEY: z.string().optional(),
  /** Anchor the ledger head after this many new entries (and at least every 30 minutes when there are any). */
  ANCHOR_EVERY: z.coerce.number().int().min(1).default(50),
  IDENTITY: z.enum(["plain", "ens"]).default("plain"),
  EVIDENCE_STORE: z.enum(["local", "0g"]).default("local"),
  DEMO_TAMPER: bool,

  HEDERA_NETWORK: z.enum(["testnet", "mainnet", "previewnet"]).default("testnet"),
  HEDERA_OPERATOR_ID: z.string().optional(),
  HEDERA_OPERATOR_KEY: z.string().optional(),
  HEDERA_TOPIC_ID: z.string().optional(),
  /** The maintenance agent's own account: it signs the escrow for a work order (with HEDERA_AGENT_ID, through Hedera Agent Kit) */
  HEDERA_AGENT_ID: z.string().optional(),
  HEDERA_AGENT_KEY: z.string().optional(),
  HEDERA_MIRROR_URL: z.string().optional(),
  /** HTS NFT collection for lot passports (the operator is treasury, supply and metadata key) */
  HEDERA_PASSPORT_TOKEN_ID: z.string().optional(),

  /** x402: Ordo sells vibration assessments per call; fees go to this Hedera account (default: the operator) */
  X402_PAY_TO: z.string().optional(),
  X402_PRICE_TINYBARS: z.coerce.bigint().default(10_000_000n),
  X402_FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
  /** Where the agent buys assessments (default: this deployment's own endpoint) and the most it pays per call */
  X402_ASSESSMENT_URL: z.string().url().optional(),
  X402_MAX_TINYBARS: z.coerce.bigint().default(50_000_000n),

  /** Primary-name lookups for signed-in wallets (Ethereum mainnet) when IDENTITY=ens */
  ENS_RPC_URL: z.string().optional(),
  /** ENSv2 names on Sepolia: the parent name and its registry and resolver come from the ENS setup workflow */
  ENS_PARENT_NAME: z.string().optional(),
  ENS_REGISTRY_ADDRESS: z.string().optional(),
  ENS_RESOLVER_ADDRESS: z.string().optional(),
  ENS_OWNER_KEY: z.string().optional(),
  ENS_SEPOLIA_RPC_URL: z.string().default("https://ethereum-sepolia-rpc.publicnode.com"),
  /** Tests point these at a local chain */
  ENS_CHAIN_ID: z.coerce.number().int().optional(),
  ENS_FACTORY_ADDRESS: z.string().optional(),
  ENS_USER_REGISTRY_IMPL: z.string().optional(),

  ZG_RPC_URL: z.string().default("https://evmrpc-testnet.0g.ai"),
  ZG_INDEXER_URL: z.string().default("https://indexer-storage-testnet-turbo.0g.ai"),
  ZG_PRIVATE_KEY: z.string().optional(),
  ZG_PROVIDER_ADDRESS: z.string().optional(),
  /** OrdoAgentNFT (ERC-7857) on 0G Galileo, from the 0G setup workflow: each agent of each site is a token */
  ZG_INFT_ADDRESS: z.string().optional(),
  ZG_CHAIN_ID: z.coerce.number().int().default(16602),
});

export type Config = z.infer<typeof Env>;
/** Where the public can reach this deployment, for links that leave the app (NFT metadata, QR codes). */
export const publicBase = (c: Config): string | null =>
  (c.PUBLIC_URL ?? (c.VERCEL_PROJECT_PRODUCTION_URL ? `https://${c.VERCEL_PROJECT_PRODUCTION_URL}` : null))?.replace(/\/$/, "") ?? null;

export const timerEnabled = (c: Config) => (c.ENGINE_TIMER === "auto" ? !c.VERCEL : c.ENGINE_TIMER === "on");
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
