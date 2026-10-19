import { useEffect, useState } from "react";
import { api, type Actor } from "../api";
import { describeAction } from "../describe";
import type { LiveState } from "../live";
import type { Approval, Decision, Forecast, Incident, LedgerEntryDto, ToolCall } from "../types";
import { agentLabel, IncidentPill, time } from "../ui";
import { ApprovalCard } from "./ApprovalCard";

export function IncidentsPage({ live }: { live: LiveState }) {
  const list = Object.values(live.incidents).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  return (
    <>
      <div className="header">
        <div>
          <div className="eyebrow">Incidents</div>
          <h1>Incident history</h1>
          <div className="muted">Every anomaly the line agent raised, from detection to the closing summary.</div>
        </div>
      </div>
      <div className="card scroll-x">
        {list.length === 0 ? (
          <div className="empty">No incidents yet.</div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>Incident</th>
                <th>Opened</th>
                <th>Asset</th>
                <th>What happened</th>
                <th>Status</th>
                <th>Downtime avoided</th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id}>
                  <td>
                    <a href={`#/incidents/${i.id}`}>{i.id}</a>
                  </td>
                  <td className="muted">{time(i.openedAt)}</td>
                  <td>{i.assetId}</td>
                  <td>{i.title}</td>
                  <td>
                    <IncidentPill s={i.status} />
                  </td>
                  <td>{i.downtimeAvoidedMin === null ? "–" : `${i.downtimeAvoidedMin} min`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

type Detail = { incident: Incident; decisions: Decision[]; approvals: Approval[]; entries: LedgerEntryDto[] };

const KIND_TITLE: Record<Decision["kind"], string> = {
  detect: "Detected",
  forecast: "Failure forecast",
  diagnose: "Root cause",
  recommend: "Recommendation",
  guard: "Policy guard",
  execute: "Executed",
  summarize: "Closed with summary",
};

function DecisionBody({ d }: { d: Decision }) {
  const data = d.data as Record<string, unknown>;
  if (d.kind === "forecast") {
    const f = data.forecast as Forecast;
    return (
      <dl className="kv">
        <dt>P(failure ≤ 24 h)</dt>
        <dd>{Math.round(f.pFailure24h * 100)}%</dd>
        <dt>Time to limit</dt>
        <dd>{f.ttfHours === null ? "not trending" : `${Math.round(f.ttfHours * 60)} min (${f.failureLimit} limit)`}</dd>
        <dt>Model</dt>
        <dd className="mono">{f.modelId}</dd>
      </dl>
    );
  }
  if (d.kind === "diagnose") {
    const dg = data.diagnosis as { evidence: { signal: string; observation: string }[] };
    return (
      <>
        <p style={{ margin: "2px 0 6px" }}>{d.summary}</p>
        <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
          {dg.evidence.map((e) => (
            <li key={e.signal + e.observation}>
              <span className="mono">{e.signal}</span>: {e.observation}
            </li>
          ))}
        </ul>
      </>
    );
  }
  if (d.kind === "recommend") {
    const r = data.recommendation as { actions: ToolCall[]; alternatives: { summary: string; tradeoff: string }[] };
    const g = data.grounding as { ok: boolean; unknownNumbers: number[] };
    return (
      <>
        <p style={{ margin: "2px 0 6px" }}>{d.summary}</p>
        <ol style={{ margin: "0 0 6px", paddingLeft: 18 }}>
          {r.actions.map((a) => (
            <li key={JSON.stringify(a)}>{describeAction(a)}</li>
          ))}
        </ol>
        {r.alternatives.length > 0 && (
          <div className="muted" style={{ fontSize: 13 }}>
            Rejected alternatives:{" "}
            {r.alternatives.map((a) => (
              <div key={a.summary}>
                · {a.summary} — <i>{a.tradeoff}</i>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <span className={`pill ${g.ok ? "ok" : "warn"}`}>{g.ok ? "numbers grounded in input" : `ungrounded numbers: ${g.unknownNumbers.join(", ")}`}</span>
        </div>
      </>
    );
  }
  if (d.kind === "guard") {
    const pol = data.policy as { outcome: string; explanation: string; ruleIds: string[] };
    return (
      <div className="muted">
        {pol.explanation} <span className="mono">[{pol.ruleIds.join(", ")}]</span>
      </div>
    );
  }
  if (d.kind === "summarize") {
    const dt = data.downtime as { minutes: number; expectedUnplanned: number; planned: number };
    return (
      <>
        <p style={{ margin: "2px 0 6px" }}>{d.summary}</p>
        <div className="muted" style={{ fontSize: 13 }}>
          Downtime avoided <b>{dt.minutes} min</b> = expected unplanned {dt.expectedUnplanned} min (MTTR 240 × P(failure)) − planned {dt.planned} min
        </div>
      </>
    );
  }
  return <p style={{ margin: "2px 0" }}>{d.summary}</p>;
}

export function IncidentPage({ id, live, actor }: { id: string; live: LiveState; actor: Actor }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = live.decisions.filter((d) => d.incidentId === id).length + Object.values(live.approvals).filter((a) => a.incidentId === id && a.status !== "pending").length + (live.incidents[id]?.status ?? "");
  useEffect(() => {
    api.incident(id).then(setDetail, (e) => setError(String(e)));
  }, [id, version]);
  if (error) return <div className="empty">{error}</div>;
  if (!detail) return <div className="empty">Loading {id}…</div>;
  const { incident, decisions, approvals } = detail;
  const llm = (decisions.find((d) => d.kind === "diagnose")?.data as { llm?: { provider: string; modelId: string; fallback: boolean } } | undefined)?.llm;

  return (
    <>
      <div className="header">
        <div>
          <div className="eyebrow">
            {incident.id} · {incident.lineId} · opened {time(incident.openedAt)}
          </div>
          <h1>{incident.title}</h1>
          <div className="btns">
            <IncidentPill s={incident.status} />
            {incident.downtimeAvoidedMin !== null && <span className="pill ok">{incident.downtimeAvoidedMin} min downtime avoided</span>}
            {llm && (
              <span className="pill">
                AI: {llm.provider} · {llm.modelId}
                {llm.fallback ? " (fallback)" : ""}
              </span>
            )}
          </div>
        </div>
        <div className="btns">
          <a className="btn" href={`#/verify/${incident.id}`}>
            Verify audit trail
          </a>
        </div>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="card-h">
            <h2>Timeline</h2>
            <span className="muted">every step is a ledger entry</span>
          </div>
          <div className="card-b">
            <div className="timeline" data-testid="timeline">
              {decisions.map((d) => {
                const cls = d.kind === "guard" && (d.data as { policy: { outcome: string } }).policy.outcome !== "allow" ? "wait" : "done";
                return (
                  <div className={`step ${cls}`} key={d.id}>
                    <div className="meta">
                      <b style={{ color: "var(--text)" }}>{KIND_TITLE[d.kind]}</b>
                      <span className="agent">{agentLabel(d.agent)}</span>
                      <span>{time(d.ts)}</span>
                      {d.confidence !== null && <span>conf. {d.confidence.toFixed(2)}</span>}
                      <a href="#/ledger" className="mono">
                        #{d.ledgerSeq}
                      </a>
                    </div>
                    {d.kind !== "guard" && d.kind !== "detect" ? <DecisionBody d={d} /> : d.kind === "guard" ? (
                      <>
                        <p style={{ margin: "2px 0" }}>{d.summary}</p>
                        <DecisionBody d={d} />
                      </>
                    ) : (
                      <p style={{ margin: "2px 0" }}>{d.summary}</p>
                    )}
                  </div>
                );
              })}
              {incident.status !== "closed" && (
                <div className="step wait">
                  <div className="meta">
                    <b style={{ color: "var(--text)" }}>Waiting</b>
                  </div>
                  <p style={{ margin: 0 }} className="muted">
                    {approvals.some((a) => a.status === "pending") ? "A person must decide before the incident can close." : "Agents are working…"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <h2>Approvals</h2>
          {approvals.length === 0 && <div className="card empty">Nothing needed a person: every action was within policy.</div>}
          {approvals.map((a) => (
            <ApprovalCard key={a.id} a={live.approvals[a.id] ?? a} actor={actor} />
          ))}
        </div>
      </div>
    </>
  );
}
