import { useEffect, useState } from "react";
import { api } from "../api";
import { ago, dateTime, pct, STATE_LABEL } from "../lib/format";
import { href, type Route } from "../lib/router";
import type { Me, OpenRole, PublicPipeline, StageState } from "../types";
import { Empty, Modal } from "../ui/kit";
import { ThemeToggle } from "../ui/ThemeToggle";
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
      <ThemeToggle />
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
    <div className="pp op">
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

type Tone = "done" | "active" | "waiting" | "held" | "idle";
const toneOf = (state: string): Tone =>
  state === "completed" || state === "done_deviation" || state === "skipped" ? "done" : state === "running" ? "active" : state === "awaiting_approval" ? "waiting" : state === "held" ? "held" : "idle";
const howOf = (s: PublicPipeline["stages"][number]) => (s.mode === "approve" ? `Gate signed by ${s.gateRole}` : s.mode === "manual" ? "Recorded by an operator" : `Automatic · escalates to ${s.gateRole}`);

/** "Signs the gate at 01 X", "Signs the gate at 02 Y" → one line naming the stage codes. */
function summarize(why: string[]) {
  const gates = why.filter((w) => w.startsWith("Signs the gate at ")).map((w) => w.slice(18).split(" ")[0]);
  const misses = why.filter((w) => w.startsWith("Decides when ")).map((w) => w.slice(13).split(" ")[0]);
  const rest = why.filter((w) => !w.startsWith("Signs the gate at ") && !w.startsWith("Decides when "));
  return [
    ...(gates.length ? [gates.length > 1 ? `Signs the gates at stages ${gates.join(", ")}` : why.find((w) => w.startsWith("Signs the gate at "))!] : []),
    ...(misses.length ? [`Decides when stage${misses.length > 1 ? "s" : ""} ${misses.join(", ")} miss${misses.length > 1 ? "" : "es"} their criteria`] : []),
    ...rest,
  ];
}

const Stat = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) => (
  <div className="op-stat">
    <span className="op-stat-l">{label}</span>
    <span className="op-stat-v">{value}</span>
    {sub && <span className="op-stat-s">{sub}</span>}
  </div>
);

function PipelinePage({ siteId, runId, me, onSignedIn }: { siteId: string; runId: string; me: Me | null; onSignedIn: (m: Me) => void }) {
  const [p, setP] = useState<PublicPipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<OpenRole | null>(null);
  const [sent, setSent] = useState<OpenRole | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    api
      .get<PublicPipeline>(`/v1/public/pipelines/${encodeURIComponent(siteId)}/${encodeURIComponent(runId)}`)
      .then(setP)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [siteId, runId]);

  if (error)
    return (
      <div className="pp op">
        <Head />
        <Empty title="This pipeline isn't public" action={<a className="btn" href={href("open")}>See all running pipelines</a>}>
          {error}
        </Empty>
      </div>
    );
  if (!p) return <div className="boot">Loading pipeline…</div>;
  // applying needs a wallet: sign in here and come straight back to the form
  if (applying && me && !me.user) return <SignIn onSignedIn={onSignedIn} />;

  const roles = me?.memberships.find((m) => m.siteId === siteId)?.roles ?? [];
  const holds = (r: OpenRole) => r.kind === "member" && (roles as string[]).includes(r.role);
  const columns = [...new Set(p.stages.map((s) => s.column))].sort((a, b) => a - b);
  const progress = Math.round(progressOf(p) * 100);
  const waiting = p.stages.filter((s) => toneOf(s.state) === "waiting" || toneOf(s.state) === "held");
  const open = p.roles.filter((r) => !r.holders).length;
  const statusTone = p.status === "running" ? (waiting.length ? "warn" : "accent") : p.status === "completed" ? "ok" : "bad";
  return (
    <div className="pp op">
      <Head>
        <a href={href("open")}>← All pipelines</a>
      </Head>

      <header className="op-hero">
        <div className="op-hero-main">
          <div className="op-eyebrow">
            <span>{p.site}</span>
            <span aria-hidden>·</span>
            <span>{p.pipeline.category}</span>
            <span aria-hidden>·</span>
            <span>v{p.pipeline.version}</span>
          </div>
          <h1>{p.pipeline.name}</h1>
          <p className="op-lede">{p.pipeline.description}</p>
          <div className="op-hero-tags">
            <span className={`tag ${statusTone}`}>{p.status === "running" ? (waiting.length ? `Running · ${waiting.length} waiting on a person` : "Running") : p.status}</span>
            {open > 0 && <span className="tag accent">{open} role{open > 1 ? "s" : ""} with nobody yet</span>}
          </div>
        </div>
        <a className="btn accent op-hero-cta" href="#take-part" onClick={(e) => (e.preventDefault(), document.getElementById("take-part")?.scrollIntoView({ behavior: "smooth" }))}>
          Take part
        </a>
      </header>

      <div className="op-stats">
        <Stat label="Progress" value={`${progress}%`} sub={<span className="progress op-stat-bar"><span style={{ width: `${progress}%` }} /></span>} />
        <Stat label="Stages done" value={`${p.metrics.completed} / ${p.metrics.total}`} />
        <Stat label="Units" value={p.quantity.toLocaleString()} sub={p.metrics.rolledYield !== null ? `${pct(p.metrics.rolledYield)} rolled yield` : undefined} />
        <Stat label="Started" value={ago(p.startedAt)} sub={p.dueAt ? `due ${dateTime(p.dueAt)}${p.metrics.onTrack === false ? " · behind" : p.metrics.onTrack ? " · on track" : ""}` : dateTime(p.startedAt)} />
      </div>

      <div className="op-layout">
        <main className="op-main">
          <section className="op-section">
            <div className="op-section-h">
              <h2>Stages</h2>
              <span className="op-legend">
                <i className="t-done" /> Done <i className="t-active" /> Running <i className="t-waiting" /> Waiting <i className="t-idle" /> Queued
              </span>
            </div>
            <ol className="op-flow">
              {columns.map((c) => {
                const group = p.stages.filter((s) => s.column === c);
                const tones = group.map((s) => toneOf(s.state));
                const tone: Tone = tones.every((t) => t === "done") ? "done" : (["held", "waiting", "active"] as Tone[]).find((t) => tones.includes(t)) ?? "idle";
                return (
                  <li key={c} className={`op-step t-${tone}`}>
                    <span className="op-dot" aria-hidden />
                    <div className={`op-step-cards${group.length > 1 ? " parallel" : ""}`}>
                      {group.map((s) => (
                        <div key={s.code} className={`op-stage t-${toneOf(s.state)}`}>
                          <div className="op-stage-h">
                            <span className="op-code">{s.code}</span>
                            <b>{s.name}</b>
                            <span className={`op-state t-${toneOf(s.state)}`}>{STATE_LABEL[s.state as StageState] ?? s.state}</span>
                          </div>
                          <div className="op-stage-meta">
                            {s.resource} · {s.agent}
                          </div>
                          <div className="op-stage-how">{howOf(s)}</div>
                          {toneOf(s.state) === "active" && s.progress > 0 && (
                            <span className="progress op-stage-bar">
                              <span style={{ width: `${Math.round(s.progress * 100)}%` }} />
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="op-section">
            <div className="op-section-h">
              <h2>Validation</h2>
            </div>
            <p className="small muted">The lot ships only after a validation package is signed Performed by, Reviewed by and Approved by.</p>
            {p.validation && p.validation.length > 0 ? (
              <ul className="op-vals">
                {p.validation.map((v) => (
                  <li key={v.ref}>
                    <span className="op-code">{v.ref}</span>
                    <span>
                      <b>{v.type}</b>
                      {v.stageCode && <span className="faint"> · stage {v.stageCode}</span>}
                    </span>
                    {v.waitingFor ? <span className="tag warn">Needs {v.waitingFor.label.toLowerCase()} · {v.waitingFor.roleLabel}</span> : <span className="tag ok">{v.status}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="op-none">No validation packages opened for this run yet.</p>
            )}
          </section>
        </main>

        <aside className="op-aside" id="take-part">
          <div className="op-section">
            <div className="op-section-h">
              <h2>Take part</h2>
            </div>
            <p className="small muted">Apply for a role at {p.site}. You sign in with a wallet, and the site's administrators approve your application with their signature.</p>
            {sent && (
              <div className="notice ok">
                <b>Application sent for {sent.label}.</b>
                <p className="small">You'll see it in the site once an administrator approves it.{sent.kind === "validator" ? " Validators then stake from Team → Validators before they can sign." : ""}</p>
              </div>
            )}
            <ul className="op-rolelist">
              {p.roles.map((r) => (
                <li key={`${r.kind}:${r.role}`} className="op-role">
                  <div className="op-role-h">
                    <b>{r.label}</b>
                    <span className={`op-holders${r.holders ? "" : " open"}`}>{r.holders ? `${r.holders} here` : "Open"}</span>
                  </div>
                  {summarize(r.why).map((w) => (
                    <p key={w} className="op-role-why">
                      {w}
                    </p>
                  ))}
                  {holds(r) ? (
                    <a className="btn sm" href="#/pipelines">
                      You hold this role · open console
                    </a>
                  ) : (
                    <button type="button" className="btn sm accent" onClick={() => setApplying(r)}>
                      Apply
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {me?.user && <MyApplications refreshKey={refresh} />}
          </div>
        </aside>
      </div>

      <Modal open={Boolean(applying && me?.user)} onClose={() => setApplying(null)} title={`Apply as ${applying?.label ?? ""}`} eyebrow={`${p.site} · ${p.pipeline.name}`} width={640}>
        {applying && (
          <ApplyForm
            key={`${applying.kind}:${applying.role}`}
            siteId={siteId}
            kind={applying.kind}
            initialRole={applying.role}
            context={{ pipeline: `${p.pipeline.name} v${p.pipeline.version} · run ${p.runId}` }}
            onCancel={() => setApplying(null)}
            onDone={() => (setSent(applying), setApplying(null), setRefresh((n) => n + 1))}
          />
        )}
      </Modal>
    </div>
  );
}
