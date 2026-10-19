import { useState } from "react";
import { api, ROLE_LABEL, type Actor } from "../api";
import { pushAlert, type LiveState } from "../live";
import type { AutonomyLevel, SignalName } from "../types";
import { AssetStatus, agentLabel, Sparkline, time } from "../ui";

const SIGNALS: { key: SignalName; label: string; unit: string; warn?: number; alarm?: number; digits: number }[] = [
  { key: "vibration_rms", label: "Vibration RMS", unit: "mm/s", warn: 4.5, alarm: 7.1, digits: 2 },
  { key: "bearing_temp", label: "Bearing temp", unit: "°C", warn: 80, alarm: 90, digits: 1 },
  { key: "spindle_load", label: "Spindle load", unit: "%", warn: 95, alarm: 105, digits: 0 },
];
const LEVELS: { l: AutonomyLevel; name: string; text: string }[] = [
  { l: "L1", name: "Assist", text: "Agents suggest; people execute every action." },
  { l: "L2", name: "Recommend", text: "Agents prepare actions; a person confirms each one." },
  { l: "L3", name: "Supervised", text: "Agents act within guardrails; out-of-policy actions escalate." },
  { l: "L4", name: "Autonomous", text: "Agents act end to end in policy; people are notified." },
];
const SCENARIOS = [
  { id: "bearing_wear", label: "Bearing wear on CNC-05" },
  { id: "overheat", label: "Overheat on CNC-05" },
  { id: "sensor_fault", label: "Faulty sensor on CNC-04" },
  { id: "normal", label: "Normal running" },
];

export function LinePage({ live, actor }: { live: LiveState; actor: Actor }) {
  const p = live.plant;
  const [busy, setBusy] = useState(false);
  if (!p) return <div className="empty">Connecting to the line…</div>;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      pushAlert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const level = LEVELS.find((x) => x.l === p.line.autonomy)!;
  const incidents = Object.values(live.incidents);
  const open = incidents.filter((i) => i.status !== "closed").length;
  const pending = Object.values(live.approvals).filter((a) => a.status === "pending").length;
  const avoided = incidents.reduce((s, i) => s + (i.downtimeAvoidedMin ?? 0), 0);
  const head = live.ledger[0];
  const anchor = live.anchors[0];

  return (
    <>
      <div className="header">
        <div>
          <div className="eyebrow">
            {p.line.id} · scenario {p.scenario.replace("_", " ")} · plant minute {p.minute} {p.running ? "· live" : "· paused"}
          </div>
          <h1>{p.line.name}</h1>
          <div className="muted">Three CNC cells, live telemetry, agents under a policy guard. Simulated plant data; real decisions and audit trail.</div>
        </div>
        <div className="btns">
          <select aria-label="Scenario" disabled={busy} defaultValue="" onChange={(e) => e.target.value && run(() => api.start(e.target.value))}>
            <option value="" disabled>
              Start scenario…
            </option>
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {p.running ? (
            <button className="btn" disabled={busy} onClick={() => run(api.pause)}>
              Pause
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => run(api.resume)}>
              Resume
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => run(() => api.step(10))} title="Advance 10 plant minutes">
            +10 min
          </button>
          <button className="btn accent" data-testid="start-demo" disabled={busy} onClick={() => run(() => api.start("bearing_wear"))}>
            Run demo incident
          </button>
        </div>
      </div>

      <div className="kpis line">
        <div className="kpi">
          <div className="label" style={{ display: "flex", justifyContent: "space-between" }}>
            Autonomy <span style={{ color: "var(--accent-700)" }}>{level.l} · {level.name}</span>
          </div>
          <div className="bars">
            {LEVELS.map((x, i) => (
              <span key={x.l} className={i <= LEVELS.indexOf(level) ? "on" : ""} />
            ))}
          </div>
          <div className="s" style={{ marginTop: 6 }}>
            {level.text}
          </div>
          {actor.role === "plant_manager" ? (
            <select aria-label="Autonomy level" value={p.line.autonomy} onChange={(e) => run(() => api.autonomy(e.target.value as AutonomyLevel, actor))} style={{ marginTop: 6 }}>
              {LEVELS.map((x) => (
                <option key={x.l} value={x.l}>
                  {x.l} · {x.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="s faint">Only the {ROLE_LABEL.plant_manager.toLowerCase()} can change this.</div>
          )}
        </div>
        <div className="kpi">
          <div className="label">Open incidents</div>
          <div className="v">{open}</div>
          <div className="s">{incidents.length} total</div>
        </div>
        <div className="kpi">
          <div className="label">Approvals</div>
          <div className="v" style={{ color: pending ? "var(--accent-700)" : undefined }}>{pending}</div>
          <div className="s">need a person</div>
        </div>
        <div className="kpi">
          <div className="label">Downtime avoided</div>
          <div className="v">{avoided} min</div>
          <div className="s" title="MTTR × P(failure) − planned maintenance">expected unplanned − planned</div>
        </div>
        <div className="kpi">
          <div className="label">Audit ledger</div>
          <div className="v">#{head?.seq ?? 0}</div>
          <div className="s">{anchor ? `anchored to #${anchor.toSeq} (${anchor.kind})` : "not anchored yet"}</div>
        </div>
        <div className="kpi">
          <div className="label">Unplanned stops</div>
          <div className="v" style={{ color: p.failures.length ? "var(--bad)" : undefined }}>{p.failures.length}</div>
          <div className="s">this run</div>
        </div>
      </div>

      <div className="grid3">
        {p.assets.map((a) => {
          const batch = p.batches.find((b) => b.assetId === a.id && b.status !== "done");
          const h = live.history[a.id] ?? {};
          return (
            <div className="card asset" key={a.id} data-testid={`asset-${a.id}`}>
              <div className="card-h">
                <div>
                  <h3>{a.name}</h3>
                  <div className="faint mono">{a.ensName ?? a.id}</div>
                </div>
                <AssetStatus s={a.status} />
              </div>
              <div className="card-b">
                {SIGNALS.map((s) => {
                  const v = a.latest[s.key];
                  const tone = v && s.alarm !== undefined && v.value >= s.alarm ? "alarm" : v && s.warn !== undefined && v.value >= s.warn ? "warn" : "";
                  return (
                    <div className="sig" key={s.key}>
                      <span className="muted">{s.label}</span>
                      <Sparkline values={h[s.key] ?? []} warn={s.warn} alarm={s.alarm} />
                      <span className={`val ${tone}`}>
                        {v ? (v.quality === "bad" ? <span className="pill bad">bad</span> : `${v.value.toFixed(s.digits)} ${s.unit}`) : "–"}
                      </span>
                    </div>
                  );
                })}
                <div style={{ marginTop: 10 }}>
                  {batch ? (
                    <>
                      <div className="btns" style={{ justifyContent: "space-between", fontSize: 12 }}>
                        <span>
                          Batch <b>{batch.id}</b> · {batch.status}
                        </span>
                        <span className="muted">
                          {batch.produced}/{batch.total}
                        </span>
                      </div>
                      <div className="progress" style={{ marginTop: 4 }}>
                        <span style={{ width: `${(batch.produced / batch.total) * 100}%` }} />
                      </div>
                    </>
                  ) : (
                    <span className="faint" style={{ fontSize: 12 }}>
                      No batch assigned{a.maintenanceAt !== null ? ` · maintenance at minute ${a.maintenanceAt}` : ""}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="section">
        <div className="section-h">
          <h2>Decision stream</h2>
          <span className="muted">What the agents and people decided, and why</span>
        </div>
        <div className="card">
          <div className="card-b stream">
            {live.decisions.length === 0 && <div className="empty">No decisions yet. Start the demo incident.</div>}
            {live.decisions.slice(0, 14).map((d) => (
              <div className="row" key={d.id}>
                <span className="faint">{time(d.ts)}</span>
                <span className="agent">{agentLabel(d.agent)}</span>
                <span>
                  <a href={`#/incidents/${d.incidentId}`}>{d.incidentId}</a> · {d.summary}
                </span>
                <span className="faint" style={{ textAlign: "right" }}>
                  {d.confidence !== null ? `conf. ${d.confidence.toFixed(2)}` : `#${d.ledgerSeq}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
