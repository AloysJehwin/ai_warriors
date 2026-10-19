/**
 * Deploys AgentSpendVault + OrdoPolicyRegistry to Hedera testnet over JSON-RPC (Hashio, chain 296),
 * allow-lists the vendor, funds the vault and publishes the LINE-02 policy hash.
 * Run bootstrap-hedera first. Verify afterwards on Sourcify (chain 296) so source shows on HashScan.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseEther, toBytes, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadPolicy } from "../../server/src/domain/policy.js";
import { JSON_RPC, loadDeployments, need, saveDeployments } from "./env.js";

const hederaTestnet = defineChain({ id: 296, name: "Hedera Testnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [JSON_RPC] } } });
const TINYBAR = 100_000_000n; // inside the EVM, Hedera reports HBAR in tinybars (8 decimals)

const d = loadDeployments();
if (!d?.accounts.agent || !d.accounts.vendor || !d.accounts.maintenance_lead || !d.accounts.plant_manager) throw new Error("Run bootstrap:hedera first");
const operator = privateKeyToAccount(need("HEDERA_OPERATOR_KEY").startsWith("0x") ? (need("HEDERA_OPERATOR_KEY") as Hex) : (`0x${need("HEDERA_OPERATOR_KEY")}` as Hex));
const transport = http(JSON_RPC);
const pub = createPublicClient({ chain: hederaTestnet, transport });
const wallet = (acct = operator) => createWalletClient({ chain: hederaTestnet, transport, account: acct });
const art = (n: string) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };

async function deploy(name: "AgentSpendVault" | "OrdoPolicyRegistry", args: unknown[]): Promise<Hex> {
  if (d!.contracts[name]) {
    console.log(`${name} already at ${d!.contracts[name]}`);
    return d!.contracts[name] as Hex;
  }
  const { abi, bytecode } = art(name);
  const hash = await wallet().deployContract({ abi, bytecode, args, gas: 3_000_000n } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
  d!.contracts[name] = r.contractAddress;
  saveDeployments(d!);
  console.log(`${name} deployed at ${r.contractAddress} (tx ${hash})`);
  return r.contractAddress;
}

const send = async (acct: ReturnType<typeof privateKeyToAccount>, address: Hex, name: string, fn: string, args: unknown[]) => {
  const hash = await wallet(acct).writeContract({ address, abi: art(name).abi, functionName: fn, args, gas: 400_000n } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`${name}.${fn} → ${r.status} (${hash})`);
};

const vault = await deploy("AgentSpendVault", [operator.address, d.accounts.agent.evmAddress, d.accounts.maintenance_lead.evmAddress, { perTx: 10n * TINYBAR, perDay: 30n * TINYBAR }]);
const registry = await deploy("OrdoPolicyRegistry", [operator.address, d.accounts.plant_manager.evmAddress]);

await send(operator, vault, "AgentSpendVault", "setVendor", [d.accounts.vendor.evmAddress, true]);
const fund = await wallet().sendTransaction({ to: vault, value: parseEther("40") }); // JSON-RPC value is 18-decimal weibar
await pub.waitForTransactionReceipt({ hash: fund });
console.log(`funded vault with 40 HBAR (${fund})`);

const policy = loadPolicy(readFileSync(new URL("../../policies/default.yaml", import.meta.url), "utf8"));
const pm = privateKeyToAccount(d.accounts.plant_manager.key as Hex);
const current = (await pub.readContract({ address: registry, abi: art("OrdoPolicyRegistry").abi, functionName: "policies", args: [keccak256(toBytes(policy.policy.id))] })) as [number, Hex, number, bigint];
if (current[2] < policy.policy.version)
  await send(pm, registry, "OrdoPolicyRegistry", "setPolicy", [keccak256(toBytes(policy.policy.id)), 3, `0x${policy.hash.slice(7)}`, policy.policy.version]);
else console.log(`policy v${current[2]} already published`);

console.log(`
# ---- add to server/.env ----
HEDERA_VAULT_ADDRESS=${vault}
HEDERA_POLICY_REGISTRY_ADDRESS=${registry}
HEDERA_JSON_RPC_URL=${JSON_RPC}
# Verify source: npx --yes @hashgraph/... or https://sourcify.dev (chain 296) with artifacts/ + metadata
`);
