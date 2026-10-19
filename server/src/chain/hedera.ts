/**
 * Hedera adapters. Written against @hiero-ledger/sdk v2.9x. Requires testnet accounts from
 * `contracts/scripts/` (see docs/contracts-and-deployment.md). Not exercised in CI: the CI
 * sandbox has no route to Hedera; run `pnpm --filter @ordo/server smoke:hedera` locally.
 */
import {
  AccountId,
  Client,
  ContractCallQuery,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  PrivateKey,
  ScheduleCreateTransaction,
  ScheduleId,
  ScheduleInfoQuery,
  ScheduleSignTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import type { Config } from "../config.js";
import type { Approval, Role } from "../domain/types.js";
import type { AnchorAdapter, AnchorInput, ApprovalRail, ExternalRef, PaymentRail } from "../adapters/rails.js";

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
  const roles: Partial<Record<Role, Account>> = {};
  if (cfg.HEDERA_ROLE_ACCOUNTS) {
    const parsed = JSON.parse(cfg.HEDERA_ROLE_ACCOUNTS) as Record<string, { id: string; key: string }>;
    for (const [role, v] of Object.entries(parsed)) roles[role as Role] = acct(v.id, v.key);
  }

  return {
    anchor(): AnchorAdapter {
      if (!cfg.HEDERA_TOPIC_ID) throw new Error("ANCHOR=hedera needs HEDERA_TOPIC_ID");
      const topicId = TopicId.fromString(cfg.HEDERA_TOPIC_ID);
      return {
        kind: "hedera-hcs",
        async anchor(i: AnchorInput) {
          const message = JSON.stringify({ v: 1, line: i.lineId, toSeq: i.toSeq, entryHash: i.entryHash, incident: i.incidentId, evidence: i.evidence });
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

    /** Approval = a scheduled 1-tinybar transfer that only the required role's key can release. */
    approvals(): ApprovalRail {
      return {
        kind: "hedera-scheduled",
        async request(a: Approval): Promise<ExternalRef | null> {
          const signer = roles[a.requiredRole];
          if (!signer) throw new Error(`No Hedera account configured for role ${a.requiredRole}`);
          const inner = new TransferTransaction()
            .addHbarTransfer(signer.id, Hbar.fromTinybars(-1))
            .addHbarTransfer(operator.id, Hbar.fromTinybars(1))
            .setTransactionMemo(`ordo:approval:${a.id}`);
          const tx = await new ScheduleCreateTransaction().setScheduledTransaction(inner).setScheduleMemo(`ordo:approval:${a.id}`).execute(client);
          const receipt = await tx.getReceipt(client);
          const scheduleId = receipt.scheduleId?.toString();
          if (!scheduleId) throw new Error("Schedule was not created");
          return { ref: scheduleId, url: `${hashscan}/schedule/${scheduleId}` };
        },
        async confirm(a: Approval, signerRole: Role): Promise<ExternalRef | null> {
          if (!a.externalRef) return null;
          if (signerRole !== a.requiredRole) throw new Error(`On-chain approval must be signed by ${a.requiredRole}`);
          const signer = roles[signerRole];
          if (!signer) throw new Error(`No Hedera account configured for role ${signerRole}`);
          const scheduleId = ScheduleId.fromString(a.externalRef);
          const tx = await (await new ScheduleSignTransaction().setScheduleId(scheduleId).freezeWith(client).sign(signer.key)).execute(client);
          await tx.getReceipt(client);
          const info = await new ScheduleInfoQuery().setScheduleId(scheduleId).execute(client);
          return { ref: `${a.externalRef} executed=${info.executed ? "yes" : "no"}`, url: `${hashscan}/schedule/${a.externalRef}` };
        },
      };
    },

    /** The Healer pays the vendor through AgentSpendVault (caps enforced on-chain), or directly if no vault is set. */
    payments(): PaymentRail {
      if (!cfg.HEDERA_AGENT_ID || !cfg.HEDERA_AGENT_KEY || !cfg.HEDERA_VENDOR_ID) throw new Error("PAYMENTS=hedera needs HEDERA_AGENT_ID, HEDERA_AGENT_KEY and HEDERA_VENDOR_ID");
      const agent = acct(cfg.HEDERA_AGENT_ID, cfg.HEDERA_AGENT_KEY);
      const agentClient = Client.forName(network).setOperator(agent.id, agent.key);
      const vendor = AccountId.fromString(cfg.HEDERA_VENDOR_ID);
      return {
        kind: cfg.HEDERA_VAULT_ADDRESS ? "hedera-vault" : "hedera-transfer",
        async pay(p) {
          if (p.amount > 10) throw new Error("Payment above the 10 HBAR app-side cap");
          if (cfg.HEDERA_VAULT_ADDRESS) {
            const memoHash = Buffer.from(p.incidentHash.replace("sha256:", "").padStart(64, "0").slice(0, 64), "hex");
            const tx = await new ContractExecuteTransaction()
              .setContractId(ContractId.fromEvmAddress(0, 0, cfg.HEDERA_VAULT_ADDRESS))
              .setGas(300_000)
              .setFunction(
                "pay",
                new ContractFunctionParameters()
                  .addAddress(vendor.toEvmAddress())
                  .addUint256(Math.round(p.amount * 1e8)) // tinybar inside the EVM
                  .addBytes32(memoHash),
              )
              .execute(agentClient);
            await tx.getReceipt(agentClient);
            return { ref: tx.transactionId.toString(), url: `${hashscan}/transaction/${tx.transactionId.toString()}` };
          }
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

    /** Compares the local policy hash with OrdoPolicyRegistry.policies(keccak("LINE-02")). */
    policyRegistryCheck(policyHash: string): (() => Promise<{ ok: boolean; detail: string }>) | undefined {
      const addr = cfg.HEDERA_POLICY_REGISTRY_ADDRESS;
      if (!addr) return undefined;
      return async () => {
        const { keccak256, toBytes } = await import("viem");
        const line = Buffer.from(keccak256(toBytes("LINE-02")).slice(2), "hex");
        const r = await new ContractCallQuery()
          .setContractId(ContractId.fromEvmAddress(0, 0, addr))
          .setGas(100_000)
          .setFunction("policies", new ContractFunctionParameters().addBytes32(line))
          .execute(client);
        const onChain = Buffer.from(r.getBytes32(1)).toString("hex");
        const ok = onChain === policyHash.replace("sha256:", "");
        return { ok, detail: ok ? `Matches OrdoPolicyRegistry (version ${r.getUint32(2)})` : "Local policy differs from OrdoPolicyRegistry" };
      };
    },
  };
}
