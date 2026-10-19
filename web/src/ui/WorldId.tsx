import { lazy, Suspense, useEffect, useState } from "react";
import { api, ApiError } from "../api";

interface WorldIdRequest {
  appId: `app_${string}`;
  action: string;
  environment: "production" | "staging";
  signal: string;
  rpContext: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
}

// IDKit is only needed on the validator steps, so it loads when one is shown
const Widget = lazy(() => import("@worldcoin/idkit").then((m) => ({ default: m.IDKitRequestWidget })));
const orbLegacy = (signal: string) => import("@worldcoin/idkit").then((m) => m.orbLegacy({ signal }));

/** Whether this deployment checks validators with World ID; null while asking. */
export function useWorldIdEnabled() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    api.get("/v1/world-id/request").then(
      () => setOn(true),
      (e) => setOn(!(e instanceof ApiError && e.status === 404)),
    );
  }, []);
  return on;
}

/**
 * A World ID check for the signed-in wallet. The proof's signal is the wallet, and the server keeps one
 * World ID per validator seat at a site, so one person can't validate from two wallets.
 */
export function WorldIdButton({ done, onProof }: { done: boolean; onProof: (result: unknown) => void | Promise<void> }) {
  const [req, setReq] = useState<(WorldIdRequest & { preset: Awaited<ReturnType<typeof orbLegacy>> }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setError(null);
    try {
      // each request carries a fresh RP signature that expires after a few minutes
      const r = await api.get<WorldIdRequest>("/v1/world-id/request");
      setReq({ ...r, preset: await orbLegacy(r.signal) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="row-between">
      <span className="small">
        {done ? <b>Verified with World ID</b> : "Prove you are one person, so no one validates here from two wallets. Ordo keeps only an anonymous World ID reference."}
        {error && <div className="small bad">{error}</div>}
      </span>
      {!done && (
        <button type="button" className="btn sm" onClick={start}>
          Verify with World ID
        </button>
      )}
      {req && (
        <Suspense fallback={null}>
          <Widget
            open
            onOpenChange={(o) => !o && setReq(null)}
            app_id={req.appId}
            action={req.action}
            environment={req.environment}
            rp_context={req.rpContext}
            allow_legacy_proofs={false}
            preset={req.preset}
            handleVerify={async (result) => onProof(result)}
            onSuccess={() => setReq(null)}
            onError={(code) => setError(`World ID: ${code.replaceAll("_", " ")}`)}
          />
        </Suspense>
      )}
    </div>
  );
}
