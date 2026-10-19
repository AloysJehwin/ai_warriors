import { createWalletClient, custom, getAddress, type EIP1193Provider } from "viem";
import { createSiweMessage } from "viem/siwe";
import { api } from "../api";
import type { Me, TypedSignature } from "../types";

export interface WalletInfo {
  id: string;
  name: string;
  icon: string | null;
  provider: EIP1193Provider;
}

/** EIP-6963: every installed wallet announces itself; fall back to window.ethereum. */
export function discoverWallets(onChange: (w: WalletInfo[]) => void): () => void {
  const found = new Map<string, WalletInfo>();
  const emit = () => onChange([...found.values()]);
  const handler = (e: Event) => {
    const d = (e as CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider }>).detail;
    if (!d?.provider) return;
    found.set(d.info.rdns || d.info.uuid, { id: d.info.rdns || d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider });
    emit();
  };
  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const t = setTimeout(() => {
    const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (!found.size && eth) {
      found.set("injected", { id: "injected", name: "Browser wallet", icon: null, provider: eth });
      emit();
    } else emit();
  }, 400);
  return () => {
    clearTimeout(t);
    window.removeEventListener("eip6963:announceProvider", handler);
  };
}

let active: WalletInfo | null = null;
const remember = (id: string) => {
  try {
    localStorage.setItem("ordo.wallet", id);
  } catch {
    /* private mode */
  }
};
export const rememberedWallet = () => {
  try {
    return localStorage.getItem("ordo.wallet");
  } catch {
    return null;
  }
};
export const setActiveWallet = (w: WalletInfo) => {
  active = w;
};

async function client(expected?: string) {
  if (!active) throw new Error("Connect your wallet first");
  const c = createWalletClient({ transport: custom(active.provider) });
  const [account] = await c.requestAddresses();
  if (!account) throw new Error("The wallet returned no account");
  if (expected && getAddress(account) !== getAddress(expected)) throw new Error(`Switch your wallet to ${short(expected)}: you are signed in with that address`);
  return { c, account };
}

/** Sign-In with Ethereum: the server issues a nonce, the wallet signs the EIP-4361 message. */
export async function signIn(w: WalletInfo): Promise<Me> {
  active = w;
  const { c, account } = await client();
  const chainId = await c.getChainId().catch(() => 1);
  const n = await api.post<{ nonce: string; domain: string; uri: string }>("/v1/auth/nonce");
  const message = createSiweMessage({
    domain: n.domain,
    address: account,
    statement: "Sign in to Ordo. This proves you control this wallet; it does not send a transaction or cost gas.",
    uri: n.uri,
    version: "1",
    chainId,
    nonce: n.nonce,
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 10 * 60_000),
  });
  const signature = await c.signMessage({ account, message });
  remember(w.id);
  return api.post<Me>("/v1/auth/verify", { message, signature });
}

export async function walletChainId(): Promise<number | undefined> {
  if (!active) return undefined;
  return createWalletClient({ transport: custom(active.provider) }).getChainId().catch(() => undefined);
}

/** Sign the exact EIP-712 typed data the server issued. */
export async function signTyped(typed: TypedSignature, expectedAddress: string): Promise<`0x${string}`> {
  const { c, account } = await client(expectedAddress);
  return c.signTypedData({ account, domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: typed.message } as never);
}

export const hasActiveWallet = () => active !== null;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
