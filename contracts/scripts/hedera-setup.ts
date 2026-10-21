/**
 * Creates Ordo's Hedera testnet resources with the operator account. Run from the "Hedera setup" workflow
 * (.github/workflows/hedera-setup.yml), or locally:
 *
 *   HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=0x… pnpm --filter @ordo/contracts setup:hedera topic
 *   … setup:hedera agent        SECRET_OUT=<file> receives HEDERA_AGENT_KEY; the key is never printed
 *   … setup:hedera contracts    TRUST_CONTRACT_ADDRESS=0x… (OrdoTrust) is required
 *   … setup:hedera passport     the HTS NFT collection for lot passports
 *   … setup:hedera payonproof   OrdoPayOnProof: needs STABLECOIN_ADDRESS and STABLECOIN_TOKEN_ADDRESS (Ordo USD, made with
 *                               Stablecoin Studio by tools/stablecoin/create.cjs) and TRUST_CONTRACT_ADDRESS
 *
 * Prints only public values: the variables to set in Vercel.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { AccountCreateTransaction, Client, Hbar, PrivateKey, TokenCreateTransaction, TokenSupplyType, TokenType, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { need } from "./env.js";

const parseKey = (k: string) => (k.trim().startsWith("302") ? PrivateKey.fromStringDer(k.trim()) : PrivateKey.fromStringECDSA(k.trim().replace(/^0x/, "")));
const operatorId = need("HEDERA_OPERATOR_ID");
const operatorKey = parseKey(need("HEDERA_OPERATOR_KEY"));
const task = process.argv[2];

if (task === "topic") {
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  const tx = await new TopicCreateTransaction().setTopicMemo("ordo:ledger:v2").setSubmitKey(operatorKey.publicKey).setAdminKey(operatorKey.publicKey).execute(client);
  const id = (await tx.getReceipt(client)).topicId!.toString();
  client.close();
  console.log(`Ledger topic created: https://hashscan.io/testnet/topic/${id}

# ---- set in Vercel (Production and Preview) ----
ANCHOR=hedera
HEDERA_NETWORK=testnet
HEDERA_TOPIC_ID=${id}
`);
} else if (task === "agent") {
  const out = need("SECRET_OUT");
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  const key = PrivateKey.generateECDSA();
  const hbar = Number(process.env.AGENT_HBAR ?? 20);
  const tx = await new AccountCreateTransaction().setECDSAKeyWithAlias(key).setInitialBalance(new Hbar(hbar)).setAccountMemo("ordo:maintenance-agent").execute(client);
  const id = (await tx.getReceipt(client)).accountId!.toString();
  client.close();
  writeFileSync(out, `HEDERA_AGENT_KEY=0x${key.toStringRaw()}\n`, { mode: 0o600 });
  console.log(`Maintenance agent account created with ${hbar} HBAR: https://hashscan.io/testnet/account/${id}
Its EVM address (give it caps in Ordo): ${privateKeyToAccount(`0x${key.toStringRaw()}`).address}

# ---- set in Vercel (Production and Preview); HEDERA_AGENT_KEY was written to ${out} ----
HEDERA_AGENT_ID=${id}
`);
} else if (task === "contracts") {
  const trust = need("TRUST_CONTRACT_ADDRESS") as Hex;
  const rpc = process.env.TRUST_RPC_URL ?? "https://testnet.hashio.io/api";
  const chainId = Number(process.env.TRUST_CHAIN_ID ?? 296);
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const account = privateKeyToAccount(`0x${operatorKey.toStringRaw()}`);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account });
  const deployed: Record<string, Hex> = {};
  for (const name of ["OrdoWorkOrders", "OrdoPolicies"]) {
    const { abi, bytecode } = JSON.parse(readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };
    const hash = await wallet.deployContract({ abi, bytecode, args: [trust], gas: 4_000_000n } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
    deployed[name] = r.contractAddress;
    console.log(`${name} deployed at ${r.contractAddress} (tx ${hash})`);
  }
  console.log(`
# ---- set in Vercel (Production and Preview) ----
TRUST_WORKORDERS_ADDRESS=${deployed.OrdoWorkOrders}
TRUST_POLICIES_ADDRESS=${deployed.OrdoPolicies}
`);
} else if (task === "payonproof") {
  const [coin, token, trust] = [need("STABLECOIN_ADDRESS"), need("STABLECOIN_TOKEN_ADDRESS"), need("TRUST_CONTRACT_ADDRESS")] as Hex[];
  const rpc = process.env.TRUST_RPC_URL ?? "https://testnet.hashio.io/api";
  const chainId = Number(process.env.TRUST_CHAIN_ID ?? 296);
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const account = privateKeyToAccount(`0x${operatorKey.toStringRaw()}`);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account });
  const { abi, bytecode } = JSON.parse(readFileSync(new URL("../artifacts/OrdoPayOnProof.json", import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };
  const hash = await wallet.deployContract({ abi, bytecode, args: [coin, token, trust], gas: 3_000_000n } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`OrdoPayOnProof deploy failed: ${hash}`);
  console.log(`OrdoPayOnProof deployed at ${r.contractAddress} (tx ${hash}): https://hashscan.io/testnet/contract/${r.contractAddress}
It holds Ordo USD (${coin}) for a lot until OrdoTrust (${trust}) records its release.

# ---- set in Vercel (Production and Preview) ----
PAY_ON_PROOF_ADDRESS=${r.contractAddress}
`);
} else if (task === "passport") {
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  // The operator is treasury, mints (supply key) and updates metadata as the lot moves on (metadata key, HIP-657).
  const tx = await new TokenCreateTransaction()
    .setTokenName("Ordo Lot Passport")
    .setTokenSymbol("ORDOLOT")
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Infinite)
    .setTreasuryAccountId(operatorId)
    .setAdminKey(operatorKey.publicKey)
    .setSupplyKey(operatorKey.publicKey)
    .setMetadataKey(operatorKey.publicKey)
    .setTokenMemo("One NFT per production lot: its passport, from Ordo")
    .execute(client);
  const id = (await tx.getReceipt(client)).tokenId!.toString();
  client.close();
  console.log(`Lot passport collection created: https://hashscan.io/testnet/token/${id}

# ---- set in Vercel (Production and Preview) ----
HEDERA_PASSPORT_TOKEN_ID=${id}
PUBLIC_URL=<the deployment's public URL, e.g. https://aiwarriors.vercel.app>
`);
} else {
  console.error("usage: hedera-setup.ts topic | agent | contracts | passport | payonproof");
  process.exit(1);
}
