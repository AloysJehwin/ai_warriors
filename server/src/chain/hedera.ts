/**
 * Hedera adapters. Written against @hiero-ledger/sdk v2.9x. Requires testnet accounts from
 * `contracts/scripts/` (see docs/contracts-and-deployment.md). Not exercised in CI: the CI
 * sandbox has no route to Hedera; run `pnpm --filter @ordo/server smoke:hedera` locally.
 */
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TopicId,
  TopicMessageSubmitTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import type { Config } from "../config.js";
import type { AnchorAdapter, AnchorInput, PaymentRail } from "../adapters/rails.js";

interface Account {
  id: AccountId;
  key: PrivateKey;
}
const parseKey = (k: string): PrivateKey => {
  const s = k.trim();
  if (s.startsWith("302")) return PrivateKey.fromStringDer(s);
  return PrivateKey.fromStringECDSA(s.replace(/^0x/, ""));
};
const acct = (id: string, key: string): Account => ({ id: AccountId.fromString(id), key: parseKey(key) });

export function hederaFromConfig(cfg: Config) {
  if (!cfg.HEDERA_OPERATOR_ID || !cfg.HEDERA_OPERATOR_KEY) throw new Error("Hedera adapters need HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY");
  const network = cfg.HEDERA_NETWORK;
  const operator = acct(cfg.HEDERA_OPERATOR_ID, cfg.HEDERA_OPERATOR_KEY);
  const client = Client.forName(network).setOperator(operator.id, operator.key);
  const mirror = (cfg.HEDERA_MIRROR_URL ?? `https://${network}.mirrornode.hedera.com`).replace(/\/$/, "");
  const hashscan = `https://hashscan.io/${network}`;

  return {
    anchor(): AnchorAdapter {
      if (!cfg.HEDERA_TOPIC_ID) throw new Error("ANCHOR=hedera needs HEDERA_TOPIC_ID");
      const topicId = TopicId.fromString(cfg.HEDERA_TOPIC_ID);
      return {
        kind: "hedera-hcs",
        async anchor(i: AnchorInput) {
          const message = JSON.stringify({ v: 2, app: "ordo", site: i.siteId, toSeq: i.toSeq, entryHash: i.entryHash, subject: i.subject });
          const tx = await new TopicMessageSubmitTransaction({ topicId, message }).execute(client);
          const receipt = await tx.getReceipt(client);
          const sequence = receipt.topicSequenceNumber?.toString() ?? "?";
          return {
            ref: `${topicId.toString()}#${sequence}`,
            url: `${hashscan}/topic/${topicId.toString()}`,
            data: { topicId: topicId.toString(), sequence, transactionId: tx.transactionId.toString() },
          };
        },
        async verify(s) {
          const seq = String(s.data.sequence ?? "");
          const res = await fetch(`${mirror}/api/v1/topics/${String(s.data.topicId)}/messages/${seq}`);
          if (!res.ok) return { ok: false, detail: `Mirror node returned ${res.status}` };
          const body = (await res.json()) as { message: string; consensus_timestamp: string };
          const msg = JSON.parse(Buffer.from(body.message, "base64").toString("utf8")) as { toSeq: number; entryHash: string };
          const ok = msg.toSeq === s.toSeq && msg.entryHash === s.entryHash;
          return { ok, detail: ok ? `Matches HCS message #${seq}, consensus ${body.consensus_timestamp}` : `HCS message #${seq} does not match the stored anchor` };
        },
      };
    },

    /**
     * The Healer pays the vendor through AgentSpendVault (caps enforced on-chain) over JSON-RPC, so
     * msg.sender is the agent's ECDSA alias address that holds AGENT_ROLE. Without a vault it falls
     * back to a plain HBAR transfer capped in the app.
     */
    payments(): PaymentRail {
      if (!cfg.HEDERA_AGENT_ID || !cfg.HEDERA_AGENT_KEY || !cfg.HEDERA_VENDOR_ID) throw new Error("PAYMENTS=hedera needs HEDERA_AGENT_ID, HEDERA_AGENT_KEY and HEDERA_VENDOR_ID");
      const agent = acct(cfg.HEDERA_AGENT_ID, cfg.HEDERA_AGENT_KEY);
      const vendor = AccountId.fromString(cfg.HEDERA_VENDOR_ID);
      const vault = cfg.HEDERA_VAULT_ADDRESS;
      return {
        kind: vault ? "hedera-vault" : "hedera-transfer",
        async pay(p) {
          if (p.amount > 10) throw new Error("Payment above the 10 HBAR app-side cap");
          if (vault) {
            if (!cfg.HEDERA_VENDOR_EVM) throw new Error("Vault payments need HEDERA_VENDOR_EVM (the vendor's alias address)");
            const { createWalletClient, createPublicClient, defineChain, http, parseAbi } = await import("viem");
            const { privateKeyToAccount } = await import("viem/accounts");
            const chain = defineChain({ id: 296, name: "Hedera", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [cfg.HEDERA_JSON_RPC_URL] } } });
            const transport = http(cfg.HEDERA_JSON_RPC_URL);
            const account = privateKeyToAccount((cfg.HEDERA_AGENT_KEY!.startsWith("0x") ? cfg.HEDERA_AGENT_KEY : `0x${cfg.HEDERA_AGENT_KEY}`) as `0x${string}`);
            const memo = `0x${p.incidentHash.replace("sha256:", "").padStart(64, "0").slice(0, 64)}` as `0x${string}`;
            const hash = await createWalletClient({ chain, transport, account }).writeContract({
              address: vault as `0x${string}`,
              abi: parseAbi(["function pay(address vendor, uint256 amount, bytes32 incidentHash)"]),
              functionName: "pay",
              args: [cfg.HEDERA_VENDOR_EVM as `0x${string}`, BigInt(Math.round(p.amount * 1e8)), memo], // tinybar inside the EVM
              gas: 300_000n,
            });
            const r = await createPublicClient({ chain, transport }).waitForTransactionReceipt({ hash });
            if (r.status !== "success") throw new Error(`Vault payment reverted (${hash})`);
            return { ref: hash, url: `${hashscan}/transaction/${hash}` };
          }
          const agentClient = Client.forName(network).setOperator(agent.id, agent.key);
          const tx = await new TransferTransaction()
            .addHbarTransfer(agent.id, new Hbar(-p.amount))
            .addHbarTransfer(vendor, new Hbar(p.amount))
            .setTransactionMemo(p.memo.slice(0, 100))
            .execute(agentClient);
          await tx.getReceipt(agentClient);
          return { ref: tx.transactionId.toString(), url: `${hashscan}/transaction/${tx.transactionId.toString()}` };
        },
      };
    },

    /** Compares the local policy hash with OrdoPolicyRegistry.policies(keccak(policyId)) over JSON-RPC. */
    policyRegistryCheck(policyId: string, policyHash: string): (() => Promise<{ ok: boolean; detail: string }>) | undefined {
      const addr = cfg.HEDERA_POLICY_REGISTRY_ADDRESS;
      if (!addr) return undefined;
      return async () => {
        const { createPublicClient, defineChain, http, keccak256, parseAbi, toBytes } = await import("viem");
        const chain = defineChain({ id: 296, name: "Hedera", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [cfg.HEDERA_JSON_RPC_URL] } } });
        const [, onChain, version] = await createPublicClient({ chain, transport: http(cfg.HEDERA_JSON_RPC_URL) }).readContract({
          address: addr as `0x${string}`,
          abi: parseAbi(["function policies(bytes32) view returns (uint8, bytes32, uint32, uint64)"]),
          functionName: "policies",
          args: [keccak256(toBytes(policyId))],
        });
        const ok = onChain.slice(2) === policyHash.replace("sha256:", "");
        return { ok, detail: ok ? `Matches OrdoPolicyRegistry v${version} on Hedera` : "Local policy differs from OrdoPolicyRegistry on Hedera" };
      };
    },
  };
}
