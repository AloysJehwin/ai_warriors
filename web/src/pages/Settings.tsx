import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, LEVEL_LABEL, shortAddr } from "../lib/format";
import type { AutonomyLevel, AutonomyProposalView, EnsNamesResponse } from "../types";
import { Action, Field, Segmented, useToast } from "../ui/kit";
import { AutonomyModal } from "./Pipelines";

const ENS_STATUS = { pending: ["issuing…", "warn"], issued: ["issued", "ok"], revoked: ["revoked", ""], failed: ["failed", "bad"] } as const;

/** The site's ENSv2 names: the site, each person (held in their own wallet), each asset and agent. */
function EnsNames() {
  const { path, site, can } = useApp();
  const [names, setNames] = useState<EnsNamesResponse | null>(null);
  const load = () => api.get<EnsNamesResponse>(path("/names")).then(setNames);
  useEffect(() => {
    void load();
  }, [path, site]);
  if (!names?.live) return null;
  const order = ["site", "person", "agent", "asset"];
  const items = [...names.items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <section className="card section">
      <div className="card-h">
        <h2>ENS names</h2>
        <span className="faint small">ENSv2 · Sepolia · under {names.parent}</span>
      </div>
      <div className="card-b">
        <p className="small muted">
          The site has its own ENSv2 registry. Each person's name is minted to their own wallet and cannot be transferred; it carries their roles at this site and is revoked when they hold none.
        </p>
        <div className="scroll-x">
          <table className="t">
            <tbody>
              {items.map((n) => {
                const [label, tone] = ENS_STATUS[n.status];
                return (
                  <tr key={`${n.kind}:${n.ref}`}>
                    <td>
                      <a href={n.url} target="_blank" rel="noreferrer" className="mono">
                        {n.name}
                      </a>
                      <div className="faint small">{n.records.description ?? n.kind}</div>
                    </td>
                    <td>
                      <span className={`tag ${tone}`}>{label}</span>
                      {n.error && <div className="field-e small">{n.error}</div>}
                    </td>
                    <td className="r">
                      {n.txUrl && (
                        <a href={n.txUrl} target="_blank" rel="noreferrer" className="small">
                          tx
                        </a>
                      )}
                      {n.status === "failed" && can("admin") && (
                        <Action
                          className="btn sm"
                          onClick={async () => {
                            await api.post(path(`/names/${n.kind}/${encodeURIComponent(n.ref)}/retry`));
                            await load();
                          }}
                        >
                          Retry
                        </Action>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function Settings() {
  const { status, site, can, path, reloadSite, meta, me } = useApp();
  const [zone, setZone] = useState("");
  const [auto, setAuto] = useState<{ lineId: string; to?: AutonomyLevel } | null>(null);
  const [proposals, setProposals] = useState<AutonomyProposalView[]>([]);
  const toast = useToast();
  useEffect(() => {
    void api.get<AutonomyProposalView[]>(path("/autonomy/proposals")).then(setProposals);
  }, [path, site]);
  const open = proposals.filter((p) => p.status === "open");
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
                <button type="button" className="btn sm" onClick={() => setAuto({ lineId: l.id })}>
                  Change
                </button>
              </div>
            ))}
            {open.map((p) => (
              <div key={p.id} className="notice warn">
                <b>
                  {p.lineName}: {p.from} → {p.to}
                </b>{" "}
                <span className="small">
                  signed by {p.signers.map((x) => x.name ?? shortAddr(x.address)).join(", ")} {ago(p.createdAt)} · {p.signers.length} of {p.required}
                </span>
                {p.comment && <p className="small">“{p.comment}”</p>}
                {p.signers.some((x) => x.address === me.user!.address) ? (
                  <p className="small">Waiting for another plant manager to co-sign.</p>
                ) : (
                  can("plant_manager") && (
                    <div className="btns">
                      <button type="button" className="btn accent sm" onClick={() => setAuto({ lineId: p.lineId, to: p.to })}>
                        Review and co-sign
                      </button>
                    </div>
                  )
                )}
              </div>
            ))}
            <p className="faint small">
              Lowering autonomy takes one plant manager's signature. Raising it takes two{status.trust?.policies ? ", and is published to OrdoPolicies on-chain" : ""}. Every change is recorded in the ledger.
            </p>
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
            <h2>Public pipelines</h2>
          </div>
          <div className="card-b">
            <p className="muted small">
              Running pipelines are listed on the public <a href="#/open">Open pipelines</a> page, so people without an account can see what this site runs and apply for a role. It shows stages, progress and the roles needed; never order references, machine names, addresses or people's names.
            </p>
            <Segmented
              size="sm"
              value={site.publicPipelines ? "listed" : "hidden"}
              onChange={async (v) => {
                if (!can("admin")) return toast("Only an administrator can change this", "bad");
                await api.patch(path(""), { publicPipelines: v === "listed" });
                await reloadSite();
                toast(v === "listed" ? "Pipelines are listed publicly" : "Pipelines are hidden from the public list", "ok");
              }}
              options={[
                { value: "listed", label: "Listed" },
                { value: "hidden", label: "Hidden" },
              ]}
            />
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
      <EnsNames />
      {auto && (
        <AutonomyModal
          open
          onClose={() => {
            setAuto(null);
            void api.get<AutonomyProposalView[]>(path("/autonomy/proposals")).then(setProposals);
          }}
          lineId={auto.lineId}
          current={site.lines.find((l) => l.id === auto.lineId)!.autonomy}
          initial={auto.to}
        />
      )}
    </div>
  );
}
