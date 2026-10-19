/**
 * Creates the Hedera testnet resources Ordo needs. Idempotent: re-running reuses what exists.
 *   HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=0x... pnpm --filter @ordo/contracts bootstrap:hedera
 * Outputs contracts/deployments/hedera-testnet.json and the .env lines for the server.
 */
import { AccountCreateTransaction, Client, Hbar, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { loadDeployments, need, saveDeployments, type Deployments, type HederaAccount } from "./env.js";

const operatorId = need("HEDERA_OPERATOR_ID");
const operatorKeyHex = need("HEDERA_OPERATOR_KEY").replace(/^0x/, "");
const operatorKey = PrivateKey.fromStringECDSA(operatorKeyHex);
const client = Client.forTestnet().setOperator(operatorId, operatorKey);

const d: Deployments = loadDeployments() ?? {
  network: "testnet",
  operator: { id: operatorId, evmAddress: privateKeyToAccount(`0x${operatorKeyHex}`).address },
  accounts: {},
  topics: {},
  contracts: {},
};

const FUNDING: Record<keyof Deployments["accounts"], number> = { operator_role: 5, maintenance_lead: 5, plant_manager: 5, quality_engineer: 2, agent: 20, vendor: 1 };

async function account(name: keyof Deployments["accounts"]): Promise<HederaAccount> {
  const existing = d.accounts[name];
  if (existing) return existing;
  const key = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction().setECDSAKeyWithAlias(key).setInitialBalance(new Hbar(FUNDING[name])).setAccountMemo(`ordo:${name}`).execute(client);
  const receipt = await tx.getReceipt(client);
  const hex = `0x${key.toStringRaw()}` as const;
  const a = { id: receipt.accountId!.toString(), key: hex, evmAddress: privateKeyToAccount(hex).address };
  d.accounts[name] = a;
  saveDeployments(d);
  console.log(`created ${name}: ${a.id} (${a.evmAddress})`);
  return a;
}

async function topic(name: "ledger" | "build", memo: string): Promise<string> {
  if (d.topics[name]) return d.topics[name]!;
  const tx = await new TopicCreateTransaction().setTopicMemo(memo).setSubmitKey(operatorKey.publicKey).setAdminKey(operatorKey.publicKey).execute(client);
  const id = (await tx.getReceipt(client)).topicId!.toString();
  d.topics[name] = id;
  saveDeployments(d);
  console.log(`created topic ${name}: ${id}`);
  return id;
}

for (const n of Object.keys(FUNDING) as (keyof Deployments["accounts"])[]) await account(n);
await topic("ledger", "ordo:ledger:LINE-02:v1");
await topic("build", "ordo:build");
client.close();

const a = d.accounts;
const roles = {
  operator: { id: a.operator_role!.id, key: a.operator_role!.key },
  maintenance_lead: { id: a.maintenance_lead!.id, key: a.maintenance_lead!.key },
  plant_manager: { id: a.plant_manager!.id, key: a.plant_manager!.key },
  quality_engineer: { id: a.quality_engineer!.id, key: a.quality_engineer!.key },
};
console.log(`
# ---- add to server/.env ----
ANCHOR=hedera
APPROVALS=hedera
PAYMENTS=hedera
HEDERA_NETWORK=testnet
HEDERA_OPERATOR_ID=${operatorId}
HEDERA_OPERATOR_KEY=0x${operatorKeyHex}
HEDERA_TOPIC_ID=${d.topics.ledger}
HEDERA_ROLE_ACCOUNTS='${JSON.stringify(roles)}'
HEDERA_AGENT_ID=${a.agent!.id}
HEDERA_AGENT_KEY=${a.agent!.key}
HEDERA_VENDOR_ID=${a.vendor!.id}
HEDERA_VENDOR_EVM=${a.vendor!.evmAddress}
# then run: pnpm --filter @ordo/contracts deploy:hedera
`);
