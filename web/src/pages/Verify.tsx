import { useEffect, useState } from "react";
import { api } from "../api";
import type { LiveState } from "../live";
import type { VerifyReport } from "../types";
import { agentLabel } from "../ui";

export function VerifyPage({ id, live }: { id: string | null; live: LiveState }) {
  const incidents = Object.values(live.incidents).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const target = id ?? incidents.find((i) => i.status === "closed")?.id ?? incidents[0]?.id ?? null;
  const [tamper, setTamper] = useState<number | null>(null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReport(null);
    if (target) api.verify(target, tamper).then(setReport, (e) => setError(String(e)));
  }, [target, tamper, live.anchors.length]);

  return (
    <>
      <div className="header">
        <div>
          <div className="eyebrow">Verification</div>
          <h1>Can this record be trusted?</h1>
          <div className="muted">Recomputes every hash from genesis, checks the anchor and the policy that made each call.</div>
        </div>
        <div className="btns">
          <select aria-label="Incident" value={target ?? ""} onChange={(e) => (location.hash = `#/verify/${e.target.value}`)}>
            {incidents.map((i) => (
              <option key={i.id} value={i.id}>
                {i.id} · {i.assetId} · {i.status}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!target && <div className="card empty">No incidents to verify yet.</div>}
      {error && <div className="card empty">{error}</div>}
      {report && (
        <>
          <div className="kpis">
            <div className="kpi">
              <div className="label">Overall</div>
              <div className={`v check ${report.ok ? "ok" : "bad"}`} data-testid="verify-overall">
                {report.ok ? "✔ Verified" : "✘ Failed"}
              </div>
              <div className="s">{report.tamperedSeq ? `simulated tampering of #${report.tamperedSeq}` : "stored records as they are"}</div>
            </div>
            <div className="kpi">
              <div className="label">Hash chain</div>
              <div className={`v check ${report.chainOk ? "ok" : "bad"}`}>{report.chainOk ? "✔ intact" : "✘ broken"}</div>
              <div className="s">re-walked from genesis</div>
            </div>
            <div className="kpi">
              <div className="label">Anchor</div>
              <div className={`v check ${report.anchor?.ok ? "ok" : "bad"}`}>{report.anchor ? (report.anchor.ok ? "✔ matches" : "✘ mismatch") : "–"}</div>
              <div className="s">
                {report.anchor ? (
                  <>
                    {report.anchor.kind} ·{" "}
                    {report.anchor.url ? (
                      <a href={report.anchor.url} target="_blank" rel="noreferrer">
                        {report.anchor.ref}
                      </a>
                    ) : (
                      report.anchor.ref
                    )}
                  </>
                ) : (
                  "incident not anchored yet"
                )}
              </div>
            </div>
            <div className="kpi">
              <div className="label">Policy</div>
              <div className={`v check ${report.policy.ok ? "ok" : "bad"}`}>{report.policy.ok ? `✔ v${report.policy.version}` : "✘ mismatch"}</div>
              <div className="s">{report.policy.detail}</div>
            </div>
          </div>
          {report.anchor && <p className="muted">{report.anchor.detail}</p>}
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Step</th>
                  <th>Actor</th>
                  <th>Check</th>
                  <th>Demo</th>
                </tr>
              </thead>
              <tbody>
                {report.steps.map((s) => (
                  <tr key={s.seq}>
                    <td className="mono">{s.seq}</td>
                    <td className="mono">{s.type}</td>
                    <td className="agent">{agentLabel(s.actor)}</td>
                    <td>
                      <span className={`check ${s.ok ? "ok" : "bad"}`}>{s.ok ? "✔" : "✘"}</span> <span className="muted">{s.reason ?? ""}</span>
                    </td>
                    <td>
                      {tamper === s.seq ? (
                        <button className="btn sm" onClick={() => setTamper(null)}>
                          Restore
                        </button>
                      ) : (
                        <button className="btn sm danger" data-testid={`tamper-${s.seq}`} onClick={() => setTamper(s.seq)}>
                          Simulate tampering
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ fontSize: 12 }}>
            “Simulate tampering” edits a copy of one stored entry in memory before verifying. Nothing in the real ledger changes.
          </p>
        </>
      )}
    </>
  );
}
