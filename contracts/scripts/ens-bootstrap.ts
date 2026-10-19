/**
 * Creates ENS subnames for Ordo's line, machines and agents under a wrapped Sepolia parent name
 * and sets their text records. Take contract addresses from the official ENS deployments list:
 *   ENS_RPC_URL=https://... ENS_OWNER_KEY=0x... ENS_PARENT_NAME=ordo-mfg.eth \
 *   ENS_NAME_WRAPPER=0x... ENS_PUBLIC_RESOLVER=0x... tsx scripts/ens-bootstrap.ts
 */
import { createPublicClient, createWalletClient, http, labelhash, namehash, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { need } from "./env.js";

const parent = need("ENS_PARENT_NAME");
const wrapper = need("ENS_NAME_WRAPPER") as Hex;
const resolver = need("ENS_PUBLIC_RESOLVER") as Hex;
const account = privateKeyToAccount(need("ENS_OWNER_KEY") as Hex);
const transport = http(need("ENS_RPC_URL"));
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });
const app = process.env.ORDO_URL ?? "https://ordo.example";

const ENTITIES: { label: string; type: string; text: Record<string, string> }[] = [
  { label: "line-02", type: "line", text: { description: "Ordo · Line 02 · Machining", "com.ordo.autonomy": "L3", "com.ordo.ledger-topic": process.env.HEDERA_TOPIC_ID ?? "" } },
  { label: "cnc-04", type: "asset", text: { description: "CNC-04 · 5-axis mill", "com.ordo.line": "LINE-02", "com.ordo.limits": '{"vibration_rms":[4.5,7.1],"bearing_temp":[80,90]}' } },
  { label: "cnc-05", type: "asset", text: { description: "CNC-05 · 5-axis mill", "com.ordo.line": "LINE-02", "com.ordo.limits": '{"vibration_rms":[4.5,7.1],"bearing_temp":[80,90]}' } },
  { label: "cnc-07", type: "asset", text: { description: "CNC-07 · 5-axis mill", "com.ordo.line": "LINE-02", "com.ordo.limits": '{"vibration_rms":[4.5,7.1],"bearing_temp":[80,90]}' } },
  { label: "healer", type: "agent", text: { description: "Ordo Healer agent: proposes allow-listed actions; pays via AgentSpendVault", "com.ordo.vault": process.env.HEDERA_VAULT_ADDRESS ?? "" } },
  { label: "maintenance", type: "agent", text: { description: "Ordo Maintenance agent: trend-logit-v1 failure forecast" } },
];

const wrapperAbi = parseAbi(["function setSubnodeRecord(bytes32 parentNode, string label, address owner, address resolver, uint64 ttl, uint32 fuses, uint64 expiry) returns (bytes32)"]);
const resolverAbi = parseAbi(["function setText(bytes32 node, string key, string value)", "function multicall(bytes[] data) returns (bytes[])", "function text(bytes32 node, string key) view returns (string)"]);
const { encodeFunctionData } = await import("viem");

for (const e of ENTITIES) {
  const name = `${e.label}.${parent}`;
  const node = namehash(name);
  const existing = await pub.readContract({ address: resolver, abi: resolverAbi, functionName: "text", args: [node, "com.ordo.type"] }).catch(() => "");
  if (!existing) {
    const h = await wallet.writeContract({ address: wrapper, abi: wrapperAbi, functionName: "setSubnodeRecord", args: [namehash(parent), e.label, account.address, resolver, 0n, 0, 0n] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const records = { "com.ordo.type": e.type, url: `${app}/#/line`, ...e.text };
  const calls = Object.entries(records).filter(([, v]) => v).map(([k, v]) => encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, k, v] }));
  const h = await wallet.writeContract({ address: resolver, abi: resolverAbi, functionName: "multicall", args: [calls] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`✔ ${name} (${Object.keys(records).length} records)  labelhash ${labelhash(e.label).slice(0, 10)}…`);
}
console.log(`\n# add to server/.env\nIDENTITY=ens\nENS_PARENT_NAME=${parent}\nENS_RPC_URL=<sepolia rpc>`);
