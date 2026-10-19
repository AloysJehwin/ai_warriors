import { useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { LEVEL_LABEL } from "../lib/format";
import { Action, Field, useToast } from "../ui/kit";
import { AutonomyModal } from "./Pipelines";

export function Settings() {
  const { status, site, can, path, reloadSite, meta } = useApp();
  const [zone, setZone] = useState("");
  const [auto, setAuto] = useState<string | null>(null);
  const toast = useToast();
  const admin = can("admin") || can("plant_manager");
  return (
    <div>
      <div className="eyebrow">{site.name}</div>
      <h1>Settings</h1>
      <div className="grid2 section">
        <section className="card">
          <div className="card-h">
            <h2>Lines & autonomy</h2>
          </div>
          <div className="card-b">
            {site.lines.map((l) => (
              <div key={l.id} className="row-between">
                <span>
                  <b>{l.name}</b>{" "}
                  <span className="muted">
                    {l.autonomy} · {LEVEL_LABEL[l.autonomy]}
                  </span>
                </span>
                <button type="button" className="btn sm" onClick={() => setAuto(l.id)}>
                  Change
                </button>
              </div>
            ))}
            <p className="faint small">Changing autonomy is signed by a plant manager and recorded in the ledger.</p>
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2>Site code</h2>
          </div>
          <div className="card-b">
            <p className="muted small">People apply to join with this code. Share the link; their application appears under Team & validators → Applications.</p>
            <p className="mono copy">{site.id}</p>
            <div className="btns">
              <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}/#/join?site=${site.id}`).then(() => toast("Join link copied", "ok"))}>
                Copy join link
              </button>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2>Zones</h2>
          </div>
          <div className="card-b">
            <div className="chips">
              {site.zones.map((z) => (
                <span key={z.id} className="chip">
                  {z.name}
                  {admin && (
                    <button type="button" aria-label={`Delete ${z.name}`} onClick={async () => (await api.del(path(`/zones/${z.id}`)), await reloadSite())}>
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
            {admin && (
              <div className="inline">
                <input className="input grow" value={zone} onChange={(e) => setZone(e.target.value)} placeholder="New zone" />
                <Action className="btn" disabled={!zone.trim()} onClick={async () => (await api.post(path("/zones"), { name: zone.trim() }), setZone(""), await reloadSite(), toast("Zone added", "ok"))}>
                  Add
                </Action>
              </div>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2>Policy</h2>
            <span className="mono small faint">
              {status.policy.id} v{status.policy.version}
            </span>
          </div>
          <div className="card-b">
            <p className="muted small">Agents may act on their own only from the autonomy level shown; below it the action becomes an inbox item for the listed role. Low confidence or uncertain data always escalates.</p>
            <table className="t compact">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Automatic from</th>
                  <th>Otherwise needs</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries((meta as unknown as { policy: { tools: Record<string, { autoFrom: string; role?: string }>; defaultRole: string } }).policy.tools).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k.replaceAll("_", " ")}</td>
                    <td>{v.autoFrom}</td>
                    <td>{(v.role ?? (meta as unknown as { policy: { defaultRole: string } }).policy.defaultRole).replaceAll("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Field label="Policy hash">
              <span className="mono small">{status.policy.hash}</span>
            </Field>
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2>Rails</h2>
            <span className="faint small">{status.build?.env}</span>
          </div>
          <div className="card-b">
            {status.rails.map((r) => (
              <div key={r.rail} className="row-between">
                <span>{r.rail}</span>
                <span className={r.live ? "ok-text" : "muted"}>{r.mode}</span>
              </div>
            ))}
            {status.warnings.map((w) => (
              <p key={w} className="field-e small">
                {w}
              </p>
            ))}
            {status.build?.commit && <p className="faint small mono">build {status.build.commit.slice(0, 7)}</p>}
          </div>
        </section>
      </div>
      {auto && <AutonomyModal open onClose={() => setAuto(null)} lineId={auto} current={site.lines.find((l) => l.id === auto)!.autonomy} />}
    </div>
  );
}
