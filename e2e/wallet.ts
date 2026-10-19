import type { Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Injects a browser wallet into the page: an EIP-1193 provider announced through EIP-6963.
 * Signing happens in the test process with a real secp256k1 key, so the server verifies
 * genuine SIWE and EIP-712 signatures.
 */
export async function injectWallet(page: Page, key = generatePrivateKey()) {
  const account = privateKeyToAccount(key);
  await page.exposeFunction("__ordoWallet", async (method: string, params: unknown[]) => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return "0x128";
      case "personal_sign":
        return account.signMessage({ message: { raw: params[0] as `0x${string}` } });
      case "eth_signTypedData_v4": {
        const typed = JSON.parse(params[1] as string);
        delete typed.types.EIP712Domain;
        return account.signTypedData(typed);
      }
      default:
        throw new Error(`test wallet: unsupported ${method}`);
    }
  });
  await page.addInitScript(() => {
    const provider = {
      request: ({ method, params }: { method: string; params?: unknown[] }) => (window as unknown as { __ordoWallet: (m: string, p: unknown[]) => Promise<unknown> }).__ordoWallet(method, params ?? []),
      on: () => undefined,
      removeListener: () => undefined,
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({ info: { uuid: "test-wallet", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "dev.ordo.test" }, provider }),
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  return { address: account.address.toLowerCase(), key };
}
