import { useState } from "react";
import { api } from "../api";
import { pushAlert, type LiveState } from "../live";
import { agentLabel, short, time } from "../ui";

function brief(payload: unknown): string {
  const p = payload as Record<string, unknown>;
  if (typeof p.summary === "string") return p.summary;
  if (typeof p.reason === "string") return p.reason;
  if (p.action) return JSON.stringify((p.action as { tool: string }).tool);
  return Object.keys(p).slice(0, 4).join(", ");
}

export function LedgerPage({ live }: { live: LiveState }) {
  const [summary, setSummary] = useState<string | null>(null);
  const anchoredTo = live.anchors[0]?.toSeq ?? 0;
  return (
    <>
      <div className="header">
        <div>
          <div className="eyebrow">Audit ledger</div>
          <h1>Every decision, hash-chained</h1>
          <div className="muted">Each entry stores the hash of its payload and of the previous entry. The head is anchored outside the database.</div>
        </div>
        <div className="btns">
          <button className="btn accent" onClick={() => api.shiftSummary().then((s) => setSummary(`${s.summary} (ledger #${s.seq})`), (e) => pushAlert(String(e)))}>
            Generate shift summary
          </button>
        </div>
      </div>
      {summary && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-b">
            <div className="label">Shift handoff</div>
            <p style={{ margin: "6px 0 0" }}>{summary}</p>
          </div>
        </div>
      )}
      <div className="grid2">
        <div className="card scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Actor</th>
                <th>Type</th>
                <th>Detail</th>
                <th>Hash / prev</th>
              </tr>
            </thead>
            <tbody>
              {live.ledger.map((e) => (
                <tr key={e.seq}>
                  <td className="mono">
                    {e.seq}
                    {e.seq <= anchoredTo ? " ⚓" : ""}
                  </td>
                  <td className="muted">{time(e.ts)}</td>
                  <td className="agent">{agentLabel(e.actor)}</td>
                  <td className="mono">{e.type}</td>
                  <td style={{ maxWidth: 420 }}>
                    {e.incidentId && <a href={`#/incidents/${e.incidentId}`}>{e.incidentId} </a>}
                    {brief(e.payload).slice(0, 160)}
                  </td>
                  <td className="mono faint">
                    {short(e.entryHash)}
                    <br />↳ {short(e.prevHash)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {live.ledger.length === 0 && <div className="empty">Ledger is empty.</div>}
        </div>
        <div className="card">
          <div className="card-h">
            <h2>Anchors</h2>
            <span className="muted">ledger head published outside Ordo</span>
          </div>
          <div className="card-b">
            {live.anchors.length === 0 && <div className="muted">No anchors yet. One is written when an incident closes.</div>}
            {live.anchors.map((a) => (
              <div key={a.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--divider)" }}>
                <div className="btns" style={{ justifyContent: "space-between" }}>
                  <b>up to #{a.toSeq}</b>
                  <span className="pill info">{a.kind}</span>
                </div>
                <div className="mono faint">{short(a.entryHash, 16)}</div>
                <div className="mono">{a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.ref}</a> : a.ref}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {time(a.ts)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
