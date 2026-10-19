/**
 * Hedera Consensus Service anchoring of the ledger head. Written against @hiero-ledger/sdk v2.9x.
 * The topic comes from the "Hedera setup" workflow (see docs/contracts-and-deployment.md). Not exercised
 * in CI: the CI sandbox has no route to Hedera; run `pnpm --filter @ordo/server smoke:hedera` locally.
 */
import { AccountId, Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { Config } from "../config.js";
import type { AnchorAdapter, AnchorInput } from "../adapters/rails.js";

export const parseHederaKey = (k: string): PrivateKey => {
  const s = k.trim();
  if (s.startsWith("302")) return PrivateKey.fromStringDer(s);
  return PrivateKey.fromStringECDSA(s.replace(/^0x/, ""));
};

export function hederaFromConfig(cfg: Config) {
  if (!cfg.HEDERA_OPERATOR_ID || !cfg.HEDERA_OPERATOR_KEY) throw new Error("Hedera adapters need HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY");
  const network = cfg.HEDERA_NETWORK;
  const client = Client.forName(network).setOperator(AccountId.fromString(cfg.HEDERA_OPERATOR_ID), parseHederaKey(cfg.HEDERA_OPERATOR_KEY));
  const mirror = (cfg.HEDERA_MIRROR_URL ?? `https://${network}.mirrornode.hedera.com`).replace(/\/$/, "");
  const hashscan = `https://hashscan.io/${network}`;

  return {
    /** The operator client, also used to write agent audit entries to the ledger topic. */
    client,
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
  };
}
