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

  // ---- Accounts ----
  SESSION_TTL_HOURS: z.coerce.number().min(1).max(24 * 30).default(72),
  /** When set, only this wallet may create sites. Otherwise any signed-in wallet can create its own site. */
  BOOTSTRAP_ADMIN_ADDRESS: z.string().optional(),
  /** RPC used to verify smart-contract wallets (ERC-1271 / ERC-6492). Optional. */
  AUTH_RPC_URL: z.string().optional(),
  /** Chain id put in EIP-712 signatures when the client does not send its own. */
  SIGNATURE_CHAIN_ID: z.coerce.number().int().default(296),

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
  PAYMENTS: z.enum(["mock", "hedera"]).default("mock"),
  IDENTITY: z.enum(["plain", "ens"]).default("plain"),
  EVIDENCE_STORE: z.enum(["local", "0g"]).default("local"),
  DEMO_TAMPER: bool,

  HEDERA_NETWORK: z.enum(["testnet", "mainnet", "previewnet"]).default("testnet"),
  HEDERA_OPERATOR_ID: z.string().optional(),
  HEDERA_OPERATOR_KEY: z.string().optional(),
  HEDERA_TOPIC_ID: z.string().optional(),
  HEDERA_AGENT_ID: z.string().optional(),
  HEDERA_AGENT_KEY: z.string().optional(),
  HEDERA_VENDOR_ID: z.string().optional(),
  HEDERA_VAULT_ADDRESS: z.string().optional(),
  HEDERA_MIRROR_URL: z.string().optional(),
  HEDERA_POLICY_REGISTRY_ADDRESS: z.string().optional(),
  HEDERA_JSON_RPC_URL: z.string().default("https://testnet.hashio.io/api"),
  HEDERA_VENDOR_EVM: z.string().optional(),

  ENS_RPC_URL: z.string().optional(),
  ENS_PARENT_NAME: z.string().optional(),

  ZG_RPC_URL: z.string().default("https://evmrpc-testnet.0g.ai"),
  ZG_INDEXER_URL: z.string().default("https://indexer-storage-testnet-turbo.0g.ai"),
  ZG_PRIVATE_KEY: z.string().optional(),
  ZG_PROVIDER_ADDRESS: z.string().optional(),
});

export type Config = z.infer<typeof Env>;
export const timerEnabled = (c: Config) => (c.ENGINE_TIMER === "auto" ? !c.VERCEL : c.ENGINE_TIMER === "on");
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
