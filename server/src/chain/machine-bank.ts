import { AccountBalanceQuery, AccountCreateTransaction, AccountId, Hbar, PrivateKey, TopicId, TopicMessageSubmitTransaction, TransferTransaction, type Client } from "@hiero-ledger/sdk";

/** What Machines needs from Hedera (HederaMachineBank in production). Amounts in tinybars. */
export interface MachineBank {
  /** A new account with its own ECDSA key, funded by the site's treasury (the operator). */
  open(initial: bigint, memo: string): Promise<{ accountId: string; evmAddress: string; key: string; tx: string }>;
  balance(accountId: string): Promise<bigint>;
  topUp(accountId: string, amount: bigint): Promise<string>;
  /** The Hedera account behind an EVM address, if it has one. */
  accountOf(evmAddress: string): Promise<string | null>;
  /** Write a line to the ledger topic (HCS), so every purchase a machine makes is on Hedera's own audit log. */
  audit(message: Record<string, unknown>): Promise<string | null>;
  txUrl(txId: string): string;
  accountUrl(accountId: string): string;
}

const txPath = (id: string) => id.replace("@", "-").replace(/\.(\d+)$/, "-$1");

/** Machine accounts on Hedera, opened and topped up by the operator (the site's treasury). */
export function hederaMachineBank(client: Client, network: string, mirrorUrl: string, topicId: string | null): MachineBank {
  const hashscan = `https://hashscan.io/${network}`;
  return {
    async open(initial, memo) {
      const key = PrivateKey.generateECDSA();
      const tx = await new AccountCreateTransaction().setECDSAKeyWithAlias(key).setInitialBalance(Hbar.fromTinybars(initial.toString())).setAccountMemo(memo.slice(0, 100)).execute(client);
      const receipt = await tx.getReceipt(client);
      return { accountId: receipt.accountId!.toString(), evmAddress: `0x${key.publicKey.toEvmAddress()}`, key: key.toStringRaw(), tx: tx.transactionId.toString() };
    },
    async balance(accountId) {
      const b = await new AccountBalanceQuery().setAccountId(AccountId.fromString(accountId)).execute(client);
      return BigInt(b.hbars.toTinybars().toString());
    },
    async topUp(accountId, amount) {
      const operator = client.operatorAccountId!;
      const tx = await new TransferTransaction()
        .addHbarTransfer(operator, Hbar.fromTinybars((-amount).toString()))
        .addHbarTransfer(AccountId.fromString(accountId), Hbar.fromTinybars(amount.toString()))
        .execute(client);
      await tx.getReceipt(client);
      return tx.transactionId.toString();
    },
    async accountOf(evmAddress) {
      const res = await fetch(`${mirrorUrl}/api/v1/accounts/${evmAddress.toLowerCase()}`);
      if (!res.ok) return null;
      return ((await res.json()) as { account?: string }).account ?? null;
    },
    async audit(message) {
      if (!topicId) return null;
      const tx = await new TopicMessageSubmitTransaction({ topicId: TopicId.fromString(topicId), message: JSON.stringify({ v: 1, app: "ordo", ...message }) }).execute(client);
      await tx.getReceipt(client);
      return tx.transactionId.toString();
    },
    txUrl: (id) => `${hashscan}/transaction/${txPath(id)}`,
    accountUrl: (id) => `${hashscan}/account/${id}`,
  };
}
