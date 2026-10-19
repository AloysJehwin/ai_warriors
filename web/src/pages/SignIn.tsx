import { useEffect, useState } from "react";
import { discoverWallets, signIn, type WalletInfo } from "../lib/wallet";
import type { Me } from "../types";
import { Spinner } from "../ui/kit";

export function SignIn({ onSignedIn }: { onSignedIn: (m: Me) => void }) {
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => discoverWallets(setWallets), []);

  const go = async (w: WalletInfo) => {
    setBusy(w.id);
    setError(null);
    try {
      onSignedIn(await signIn(w));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(/rejected|denied/i.test(m) ? "You cancelled the request in your wallet." : m);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand big">
          <b>Ordo</b>
          <span className="eyebrow">Autonomous orchestration</span>
        </div>
        <h1>Sign in with your wallet</h1>
        <p className="muted">
          Your wallet is your identity in Ordo. Signing in proves you control the address. Every approval, release and sign-off you make later is signed with the same key, so the record shows exactly who decided what.
        </p>
        <div className="wallet-list">
          {wallets === null && (
            <p className="muted">
              <Spinner /> Looking for wallets…
            </p>
          )}
          {wallets?.map((w) => (
            <button type="button" key={w.id} className="wallet-btn" disabled={Boolean(busy)} onClick={() => go(w)}>
              {w.icon ? <img src={w.icon} alt="" width={22} height={22} /> : <span className="wallet-ico" />}
              <span>{w.name}</span>
              {busy === w.id ? <Spinner /> : <span className="faint">Sign in →</span>}
            </button>
          ))}
          {wallets && !wallets.length && (
            <div className="notice">
              <b>No browser wallet found.</b>
              <p className="muted">Install a wallet extension such as MetaMask or Rabby, create an account, then reload this page. Signing in is free and sends no transaction.</p>
            </div>
          )}
        </div>
        {error && <p className="field-e">{error}</p>}
        <ul className="auth-points">
          <li>Sign-In with Ethereum (EIP-4361) · no password, no gas</li>
          <li>Roles are granted per site by an administrator, by wallet address</li>
          <li>Decisions are EIP-712 signatures, hash-chained into an anchored ledger</li>
        </ul>
      </div>
    </div>
  );
}
