import { z } from "zod";
import { AutonomyLevel } from "./domain/types.js";
import { SCENARIOS } from "./domain/simulator.js";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default(".data"),
  POLICY_FILE: z.string().default("../policies/line-02.v1.yaml"),
  WEB_DIST: z.string().default("../web/dist"),
  CORS_ORIGINS: z.string().default(""),

  SIM_SEED: z.coerce.number().int().default(42),
  SIM_SCENARIO: z.enum(SCENARIOS).default("bearing_wear"),
  SIM_AUTOSTART: bool,
  TICK_MS: z.coerce.number().int().min(10).default(1000),
  LINE_AUTONOMY: AutonomyLevel.default("L3"),

  LLM_PROVIDER: z.enum(["offline", "gemini", "openai_compat", "0g"]).default("offline"),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(15000),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  OPENAI_COMPAT_BASE_URL: z.string().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  OPENAI_COMPAT_MODEL: z.string().optional(),

  ANCHOR: z.enum(["local", "hedera"]).default("local"),
  ANCHOR_EVERY: z.coerce.number().int().min(1).default(25),
  LEDGER_SIGNING_KEY: z.string().optional(),
  APPROVALS: z.enum(["app", "hedera"]).default("app"),
  PAYMENTS: z.enum(["mock", "hedera"]).default("mock"),
  IDENTITY: z.enum(["plain", "ens"]).default("plain"),
  EVIDENCE_STORE: z.enum(["local", "0g"]).default("local"),
  DEMO_TAMPER: bool,

  HEDERA_NETWORK: z.enum(["testnet", "mainnet", "previewnet"]).default("testnet"),
  HEDERA_OPERATOR_ID: z.string().optional(),
  HEDERA_OPERATOR_KEY: z.string().optional(),
  HEDERA_TOPIC_ID: z.string().optional(),
  HEDERA_ROLE_ACCOUNTS: z.string().optional(), // JSON: {"operator":{"id":"0.0.x","key":"0x..."},...}
  HEDERA_AGENT_ID: z.string().optional(),
  HEDERA_AGENT_KEY: z.string().optional(),
  HEDERA_VENDOR_ID: z.string().optional(),
  HEDERA_VAULT_ADDRESS: z.string().optional(),
  HEDERA_MIRROR_URL: z.string().optional(),
  HEDERA_POLICY_REGISTRY_ADDRESS: z.string().optional(),

  ENS_RPC_URL: z.string().optional(),
  ENS_PARENT_NAME: z.string().optional(),

  ZG_RPC_URL: z.string().default("https://evmrpc-testnet.0g.ai"),
  ZG_INDEXER_URL: z.string().default("https://indexer-storage-testnet-turbo.0g.ai"),
  ZG_PRIVATE_KEY: z.string().optional(),
  ZG_PROVIDER_ADDRESS: z.string().optional(),
});

export type Config = z.infer<typeof Env>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
