import { useEffect, useState } from "react";
import { api } from "../api";
import { ago, dateTime, pct, STATE_LABEL } from "../lib/format";
import { href, type Route } from "../lib/router";
import type { Me, OpenRole, PublicPipeline, StageState } from "../types";
import { Empty } from "../ui/kit";
import { ApplyForm, MyApplications } from "./Onboarding";
import { SignIn } from "./SignIn";

const progressOf = (p: PublicPipeline) => p.stages.reduce((a, s) => a + s.progress, 0) / Math.max(1, p.stages.length);

const Progress = ({ p }: { p: PublicPipeline }) => (
  <div className="progress" aria-label={`${p.metrics.completed} of ${p.metrics.total} stages done`}>
    <span style={{ width: `${Math.round(progressOf(p) * 100)}%` }} />
  </div>
);

const Head = ({ children }: { children?: React.ReactNode }) => (
  <header className="op-top">
    <a className="pp-brand" href={href("open")}>
      Ordo · Open pipelines
    </a>
    <span className="op-top-links">
      {children}
      <a className="btn sm" href="#/">
        Console
      </a>
    </span>
  </header>
);

/**
 * Running pipelines anyone can browse without an account. A newcomer sees what a site is making, which roles the
 * pipeline needs (stage gates, operators, validators), and applies for one; the site's administrators approve
 * the application with their signature, exactly as for anyone joining with the site code.
 */
export function Open({ route, me, onSignedIn }: { route: Route; me: Me | null; onSignedIn: (m: Me) => void }) {
  if (route.id && route.sub) return <PipelinePage siteId={route.id} runId={route.sub} me={me} onSignedIn={onSignedIn} />;
  return <PipelineList />;
}

function PipelineList() {
  const [rows, setRows] = useState<PublicPipeline[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<PublicPipeline[]>("/v1/public/pipelines")
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <div className="pp">
      <Head />
      <h1>Pipelines running now</h1>
      <p className="muted">Each pipeline is a production run at an Ordo site, stage by stage. Open one to see the roles it needs and apply to take part: operating stages, signing gates, or validating the release.</p>
      {error && <p className="field-e">{error}</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <Empty title="No pipelines are running right now">Check back later, or ask a site administrator for their join link.</Empty>}
      <div className="op-grid">
        {rows?.map((p) => (
          <a key={`${p.siteId}/${p.runId}`} className="pp-card op-card" href={href(`open/${p.siteId}/${p.runId}`)}>
            <div className="faint small">{p.site}</div>
            <h2>{p.pipeline.name}</h2>
            <p className="small muted">
              {p.pipeline.category} · v{p.pipeline.version} · {p.quantity} units · started {ago(p.startedAt)}
            </p>
            <Progress p={p} />
            <p className="small">
              {p.metrics.completed} of {p.metrics.total} stages done
              {p.metrics.gatesPending ? ` · ${p.metrics.gatesPending} gate${p.metrics.gatesPending > 1 ? "s" : ""} waiting for a signature` : ""}
            </p>
            <div className="chips">
              {p.roles.map((r) => (
                <span key={`${r.kind}:${r.role}`} className="chip">
                  {r.label}
                </span>
              ))}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function PipelinePage({ siteId, runId, me, onSignedIn }: { siteId: string; runId: string; me: Me | null; onSignedIn: (m: Me) => void }) {
  const [p, setP] = useState<PublicPipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<OpenRole | null>(null);
  const [sent, setSent] = useState(0);
  useEffect(() => {
    api
      .get<PublicPipeline>(`/v1/public/pipelines/${encodeURIComponent(siteId)}/${encodeURIComponent(runId)}`)
      .then(setP)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [siteId, runId]);

  if (error)
    return (
      <div className="pp">
        <Head />
        <p className="field-e">{error}</p>
        <a href={href("open")}>See all running pipelines</a>
      </div>
    );
  if (!p) return <div className="boot">Loading pipeline…</div>;
  // applying needs a wallet: sign in here and come straight back to the form
  if (applying && me && !me.user) return <SignIn onSignedIn={onSignedIn} />;

  const roles = me?.memberships.find((m) => m.siteId === siteId)?.roles ?? [];
  const holds = (r: OpenRole) => r.kind === "member" && (roles as string[]).includes(r.role);
  const columns = [...new Set(p.stages.map((s) => s.column))].sort((a, b) => a - b);
  return (
    <div className="pp">
      <Head>
        <a href={href("open")}>All pipelines</a>
      </Head>
      <header className="pp-head">
        <div>
          <div className="faint small">{p.site}</div>
          <h1>{p.pipeline.name}</h1>
          <p className="muted">{p.pipeline.description}</p>
          <p className="small muted">
            {p.pipeline.category} · v{p.pipeline.version} · {p.quantity} units · started {dateTime(p.startedAt)}
            {p.dueAt ? ` · due ${dateTime(p.dueAt)}` : ""}
            {p.metrics.rolledYield !== null ? ` · rolled yield ${pct(p.metrics.rolledYield)}` : ""}
          </p>
          <span className={`tag ${p.status === "running" ? "warn" : p.status === "completed" ? "ok" : "bad"}`}>{p.status}</span>
        </div>
      </header>

      <section className="pp-card">
        <h2>Stages</h2>
        <Progress p={p} />
        <ol className="op-stages">
          {columns.map((c) => (
            <li key={c}>
              {p.stages
                .filter((s) => s.column === c)
                .map((s) => (
                  <div key={s.code} className="op-stage">
                    <div className="row-between">
                      <b>
                        {s.code} {s.name}
                      </b>
                      <span className={`tag st-${s.state}`}>{STATE_LABEL[s.state as StageState] ?? s.state}</span>
                    </div>
                    <div className="faint small">
                      {s.resource} · {s.agent} · {s.mode === "approve" ? `gate signed by ${s.gateRole}` : s.mode === "manual" ? "recorded by an operator" : `automatic · escalates to ${s.gateRole}`}
                    </div>
                  </div>
                ))}
            </li>
          ))}
        </ol>
      </section>

      {p.validation && p.validation.length > 0 && (
        <section className="pp-card">
          <h2>Validation</h2>
          <p className="small muted">The lot is released by validation packages, each signed Performed by, Reviewed by and Approved by.</p>
          <ul className="pp-list">
            {p.validation.map((v) => (
              <li key={v.ref} className="row-between">
                <span>
                  <b>{v.ref}</b> {v.type}
                  {v.stageCode ? ` · stage ${v.stageCode}` : ""}
                </span>
                <span className="small">{v.waitingFor ? `Waiting for ${v.waitingFor.label} (${v.waitingFor.roleLabel})` : <span className="tag ok">{v.status}</span>}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="pp-card">
        <h2>Take part</h2>
        <p className="small muted">
          Apply for a role at {p.site}. You sign in with a wallet; the site's administrators review your application and approve it with their signature.
          {" "}Validators also stake from Team → Validators before they can sign.
        </p>
        <div className="op-roles">
          {p.roles.map((r) => (
            <div key={`${r.kind}:${r.role}`} className="op-role">
              <div className="row-between">
                <b>{r.label}</b>
                <span className="faint small">{r.holders ? `${r.holders} at the site` : "nobody yet"}</span>
              </div>
              <ul className="small muted">
                {r.why.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              {holds(r) ? (
                <a className="btn sm" href="#/pipelines">
                  You hold this role · open the console
                </a>
              ) : (
                <button type="button" className={`btn sm ${applying === r ? "accent" : ""}`} onClick={() => setApplying(r)}>
                  Apply
                </button>
              )}
            </div>
          ))}
        </div>
        {applying && me?.user && (
          <div className="op-apply">
            <h3>Apply as {applying.label}</h3>
            <ApplyForm
              key={`${applying.kind}:${applying.role}`}
              siteId={siteId}
              kind={applying.kind}
              initialRole={applying.role}
              context={{ pipeline: `${p.pipeline.name} v${p.pipeline.version} · run ${p.runId}` }}
              onCancel={() => setApplying(null)}
              onDone={() => (setApplying(null), setSent((n) => n + 1))}
            />
          </div>
        )}
        {me?.user && <MyApplications refreshKey={sent} />}
      </section>
    </div>
  );
}
