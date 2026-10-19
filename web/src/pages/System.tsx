import { useState } from "react";
import { api, getPasscode, setPasscode, API_BASE } from "../api";
import { pushAlert, refreshNow, type LiveState } from "../live";
import { short } from "../ui";

const RAIL_HELP: Record<string, string> = {
  database: "Postgres (Neon) in deployed environments; embedded PGlite locally.",
  ai: "LLM_PROVIDER: gemini · openai_compat · 0g · offline.",
  anchor: "ANCHOR=hedera writes ledger heads to a Hedera Consensus Service topic.",
  approvals: "APPROVALS=hedera turns approvals into scheduled transactions.",
  payments: "PAYMENTS=hedera pays vendors through AgentSpendVault.",
  identity: "IDENTITY=ens shows ENS names for machines and agents.",
  evidence: "EVIDENCE_STORE=0g stores evidence bundles on 0G Storage.",
  "policy registry": "HEDERA_POLICY_REGISTRY_ADDRESS checks the policy hash on-chain.",
};

export function SystemPage({ live }: { live: LiveState }) {
  const s = live.status;
  const [code, setCode] = useState(getPasscode());
  return (
    <>
      <div className="header">
        <div>
          <div className="eyebrow">System</div>
          <h1>What this deployment is running</h1>
          <div className="muted">Every rail is either live (a real service) or a local stand-in. Change them with environment variables; nothing else changes.</div>
        </div>
        <div className="btns">
          <button className="btn accent" onClick={() => api.anchorNow().then(() => (refreshNow(), pushAlert("Ledger head anchored")), (e) => pushAlert(String(e)))}>
            Anchor ledger now
          </button>
        </div>
      </div>
      {!s && <div className="card empty">Loading status…</div>}
      {s && (
        <div className="grid2">
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Rail</th>
                  <th>Mode</th>
                  <th>State</th>
                  <th>How to change</th>
                </tr>
              </thead>
              <tbody>
                {s.rails.map((r) => (
                  <tr key={r.rail}>
                    <td>{r.rail}</td>
                    <td className="mono">{r.mode}</td>
                    <td>
                      <span className={`pill ${r.live ? "ok" : ""}`}>{r.live ? "live" : "local"}</span>
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {RAIL_HELP[r.rail] ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="card">
              <div className="card-h">
                <h2>Build</h2>
              </div>
              <div className="card-b">
                <dl className="kv">
                  <dt>Environment</dt>
                  <dd>{s.build?.env ?? "local"}</dd>
                  <dt>Commit</dt>
                  <dd className="mono">{s.build?.commit?.slice(0, 10) ?? "–"}</dd>
                  <dt>API</dt>
                  <dd className="mono">{API_BASE || "same origin"}</dd>
                  <dt>Policy</dt>
                  <dd className="mono">
                    {s.policy.id} v{s.policy.version} · {short(s.policy.hash, 12)}
                  </dd>
                </dl>
              </div>
            </div>
            <div className="card">
              <div className="card-h">
                <h2>Passcode</h2>
                <span className={`pill ${s.passcodeRequired ? "warn" : ""}`}>{s.passcodeRequired ? "required for changes" : "not required"}</span>
              </div>
              <div className="card-b btns">
                <input type="text" aria-label="Passcode" value={code} onChange={(e) => setCode(e.target.value)} placeholder="DEMO_PASSCODE" />
                <button
                  className="btn"
                  onClick={() => {
                    setPasscode(code);
                    pushAlert("Passcode saved in this browser");
                  }}
                >
                  Save
                </button>
              </div>
            </div>
            {s.warnings.length > 0 && (
              <div className="card">
                <div className="card-h">
                  <h2>Warnings</h2>
                </div>
                <div className="card-b">
                  {s.warnings.map((w) => (
                    <div key={w} className="muted" style={{ padding: "4px 0" }}>
                      {w}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
