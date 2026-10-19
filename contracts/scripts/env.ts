import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const DEPLOYMENTS = new URL("../deployments/hedera-testnet.json", import.meta.url);
export const JSON_RPC = process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api";

export interface HederaAccount {
  id: string;
  key: string; // ECDSA hex private key — testnet only, never commit mainnet keys
  evmAddress: string;
}
export interface Deployments {
  network: "testnet";
  operator: { id: string; evmAddress: string };
  accounts: Partial<Record<"operator_role" | "maintenance_lead" | "plant_manager" | "quality_engineer" | "agent" | "vendor", HederaAccount>>;
  topics: { ledger?: string; build?: string };
  contracts: { AgentSpendVault?: string; OrdoPolicyRegistry?: string };
}

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} (see contracts/README.md)`);
  return v;
}

export function loadDeployments(): Deployments | null {
  return existsSync(DEPLOYMENTS) ? (JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployments) : null;
}
export function saveDeployments(d: Deployments): void {
  // Keys stay in this file for convenience on TESTNET. deployments/*.json is git-ignored.
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
}
