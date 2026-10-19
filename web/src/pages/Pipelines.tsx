import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { actorLabel, AGENT_LABEL, dateTime, dur, LEVEL_LABEL, LEVEL_TEXT, num, pct, STATE_LABEL, time } from "../lib/format";
import { go, href, useRoute } from "../lib/router";
import { useSign } from "../lib/sign";
import type { AutonomyLevel, DecisionView, InboxItemView, RunView, StageRunView, TemplateView, TypedSignature } from "../types";
import { DateTimePicker } from "../ui/Calendar";
import { Action, Empty, Field, Loading, Modal, Segmented, useToast } from "../ui/kit";
import { Select } from "../ui/Select";
import { HoldModal, RecordModal, StageDrawer, useStageActions } from "./pipeline/StageParts";
import { FlowView, GraphView, LedgerView } from "./pipeline/Views";

type View = "flow" | "graph" | "ledger";

export function Pipelines() {
  const { live, path, site } = useApp();
  const route = useRoute();
  const [startOpen, setStartOpen] = useState(route.query.get("start"));
  const runs = live?.runs ?? [];
  const runId = route.id ?? runs.find((r) => r.status === "running")?.id ?? runs[0]?.id ?? null;
  useEffect(() => setStartOpen(route.query.get("start")), [route.query]);
  if (!live) return <Loading />;
  return (
    <>
      {runId ? (
        <RunScreen key={runId} runId={runId} runs={runs} onNew={() => setStartOpen("")} />
      ) : (
        <div>
          <div className="eyebrow">Pipelines · {site.name}</div>
          <h1>No runs yet</h1>
          <Empty title="Start your first pipeline run" action={<button type="button" className="btn accent" onClick={() => setStartOpen("")}>Start a run</button>}>
            A run executes a template against an order. Stages are assigned to your registered assets and progress from their real part counters or from what operators record.
            {live.assets.length === 0 && (
              <>
                {" "}
                You have no assets yet: <a href={href("floor")}>register machines first</a>.
              </>
            )}
          </Empty>
        </div>
      )}
      <StartRun open={startOpen !== null} templateId={startOpen || null} onClose={() => setStartOpen(null)} onStarted={(id) => (setStartOpen(null), go(`pipelines/${id}`))} path={path} />
    </>
  );
}

function RunScreen({ runId, runs, onNew }: { runId: string; runs: RunView[]; onNew: () => void }) {
  const { path, live, names, can, refresh, site } = useApp();
  const [data, setData] = useState<{ run: RunView; decisions: DecisionView[]; inbox: InboxItemView[] } | null>(null);
  const [view, setView] = useState<View>("flow");
  const [sel, setSel] = useState<{ code: string; x: number; y: number } | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [record, setRecord] = useState<StageRunView | null>(null);
  const [hold, setHold] = useState<StageRunView | null>(null);
  const [autonomy, setAutonomy] = useState(false);
  const toast = useToast();
  const load = useCallback(async () => setData(await api.get(path(`/runs/${runId}`))), [path, runId]);
  useEffect(() => {
    void load().catch((e) => toast(String(e instanceof Error ? e.message : e), "bad"));
  }, [load, live?.headSeq, toast]);
  const actions = useStageActions(data?.run ?? (runs[0] as RunView), data?.inbox ?? [], load);
  const runOptions = useMemo(
    () =>
      runs.map((r) => ({
        value: r.id,
        label: `${r.id} · ${r.templateName}`,
        hint: `${r.orderRef} · ${r.status === "running" ? `${r.metrics.completed}/${r.metrics.total} stages` : r.status}`,
        group: r.status === "running" ? "Running" : "Last 7 days",
      })),
    [runs],
  );
  if (!data) return <Loading text="Loading run…" />;
  const { run, decisions, inbox } = data;
  const line = site.lines.find((l) => l.id === run.lineId) ?? site.lines[0]!;
  const stage = (code: string | null) => run.stages.find((s) => s.code === code) ?? null;
  const s = stage(sel?.code ?? null);
  const latest = s ? decisions.find((d) => d.stageCode === s.code) : null;

  const step = async () => {
    const r = await api.post<{ started: string[]; gateItemId: string | null }>(path(`/runs/${run.id}/step`));
    if (r.gateItemId) {
      const g = run.stages.find((x) => x.gateItemId === r.gateItemId);
      if (g) setDrawer(g.code);
      toast("A gate is waiting: open it to continue", "info");
    } else toast(r.started.length ? `Started ${r.started.join(", ")}` : "Nothing to start: running stages are waiting on data or operators", r.started.length ? "ok" : "info");
    await Promise.all([load(), refresh()]);
  };

  return (
    <div className="pipeline">
      <div className="page-head">
        <div className="ph-text">
          <div className="eyebrow">
            Run {run.id} · {run.templateCategory} · started {time(run.startedAt)} · {run.orderRef} · {run.quantity} units
            {run.status !== "running" && <span className={`tag ${run.status === "completed" ? "ok" : "bad"}`}>{run.status}</span>}
          </div>
          <h1>{run.templateName}</h1>
          <p className="muted lede">{run.templateDescription}</p>
        </div>
        <div className="ph-actions">
          <Select width={290} value={run.id} onChange={(id) => go(`pipelines/${id}`)} options={runOptions} searchable />
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: "flow", label: "Flow" },
              { value: "graph", label: "Graph" },
              { value: "ledger", label: "Ledger" },
            ]}
          />
          {run.status === "running" && can("supervisor") && (
            <Action className="btn" onClick={step}>
              Step run
            </Action>
          )}
          <a className="btn accent" href={href(`builder/${run.templateId}`)}>
            Edit in builder
          </a>
          {can("supervisor") && (
            <button type="button" className="btn" onClick={onNew}>
              New run
            </button>
          )}
        </div>
      </div>

      <div className="kpis line">
        <button type="button" className="kpi kpi-auto" onClick={() => setAutonomy(true)} title="Change autonomy level">
          <div className="kpi-row">
            <span className="label">Autonomy level</span>
            <span className="accent-text small">
              {line.autonomy} · {LEVEL_LABEL[line.autonomy]}
            </span>
          </div>
          <div className="bars">
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={i <= Number(line.autonomy.slice(1)) ? "on" : ""} />
            ))}
          </div>
          <div className="s">{LEVEL_TEXT[line.autonomy]}</div>
        </button>
        <div className="kpi">
          <span className="label">Progress</span>
          <div className="v">
            {run.metrics.completed}/{run.metrics.total}
          </div>
          <div className="s">stages complete</div>
        </div>
        <div className="kpi">
          <span className="label">Rolled yield</span>
          <div className="v">{pct(run.metrics.rolledYield)}</div>
          <div className="s">across measured stages</div>
        </div>
        <div className="kpi">
          <span className="label">Throughput</span>
          <div className="v">{num(run.metrics.throughputPerHour)}</div>
          <div className="s">units / hour shipped</div>
        </div>
        <div className="kpi">
          <span className="label">{run.status === "running" ? "Run ETA" : "Finished"}</span>
          <div className="v">{run.metrics.eta ? time(run.metrics.eta) : "—"}</div>
          <div className="s">
            {run.dueAt ? `due ${dateTime(run.dueAt)}` : "no due date"}
            {run.metrics.onTrack !== null && (run.metrics.onTrack ? " · on track" : " · late")}
          </div>
        </div>
        <div className="kpi">
          <span className="label">Agent decisions</span>
          <div className="v accent-text">{run.metrics.decisions}</div>
          <div className="s">{run.metrics.escalated} escalated to people</div>
        </div>
        <div className="kpi">
          <span className="label">Gates pending</span>
          <div className="v accent-text">{run.metrics.gatesPending}</div>
          <div className="s">needs sign-off</div>
        </div>
      </div>

      <div className="legend-row">
        <div className="legend">
          <span>
            <i className="lg done" /> Completed
          </span>
          <span>
            <i className="lg run" /> Running
          </span>
          <span>
            <i className="lg gate" /> Awaiting approval
          </span>
          <span>
            <i className="lg held" /> Held
          </span>
          <span>
            <i className="lg dev" /> Done · deviation
          </span>
          <span>
            <i className="lg queued" /> Queued
          </span>
        </div>
        <span className="faint small">Click a node to open its block</span>
      </div>

      <div className="canvas" onClick={(e) => e.target === e.currentTarget && setSel(null)}>
        {view === "flow" && <FlowView run={run} selected={sel?.code ?? null} onSelect={(code, x, y) => setSel({ code, x, y })} />}
        {view === "graph" && <GraphView run={run} selected={sel?.code ?? null} onSelect={(code, x, y) => setSel({ code, x, y })} />}
        {view === "ledger" && <LedgerView run={run} onOpen={setDrawer} />}
        {s && view !== "ledger" && (
          <div className="block" style={{ left: Math.min(sel!.x + 40, 9999), top: Math.max(10, sel!.y - 90) }} role="dialog" aria-label={`Stage ${s.code}`}>
            <div className="block-h">
              <span className="eyebrow">Stage {s.code}</span>
              <span className={`tag st-${s.state}`}>{STATE_LABEL[s.state]}</span>
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => setSel(null)}>
                ×
              </button>
            </div>
            <h3 className="block-title">{s.name}</h3>
            <div className="faint small">
              {AGENT_LABEL[s.agent]} · {s.assetName ?? "no asset"}
            </div>
            <p className="block-body">{s.outcome ?? s.waitingReason ?? (s.state === "queued" ? "Waiting on upstream stages." : "In progress.")}</p>
            {(s.state === "awaiting_approval" || s.state === "held") && s.criteriaResults.some((c) => c.ok !== true) && (
              <ul className="gate-why">
                {s.criteriaResults
                  .filter((c) => c.ok !== true)
                  .map((c) => (
                    <li key={c.label} className={c.ok === false ? "bad-text" : ""}>
                      {c.ok === false ? `Out of target: ${c.label} ${c.actual} (target ${c.target})` : `Not measured: ${c.label} (target ${c.target}), confirm before release`}
                    </li>
                  ))}
              </ul>
            )}
            <div className="metrics3">
              <div>
                <span className="label">Duration</span>
                <b>{dur(s.durationMin)}</b>
              </div>
              <div>
                <span className="label">Yield</span>
                <b>{s.yieldPct === null ? "—" : `${s.yieldPct.toFixed(1)}%`}</b>
              </div>
              <div>
                <span className="label">Output</span>
                <b>{s.throughputPerHour === null ? `${s.unitsGood}/${run.quantity}` : `${num(s.throughputPerHour)} u/h`}</b>
              </div>
            </div>
            {latest && (
              <div className="block-dec">
                <span className="label">Latest decision</span>
                <b>{latest.summary}</b>
                <div className="faint small">
                  {actorLabel(latest.agent, names)} · {time(latest.ts)}
                </div>
              </div>
            )}
            <div className="btns">
              {(s.state === "awaiting_approval" || s.state === "held") && (
                <>
                  <Action className="btn accent" disabled={!actions.canRelease(s)} title={actions.canRelease(s) ? "" : `Needs ${s.escalationRole.replaceAll("_", " ")}`} onClick={() => actions.approve(s)}>
                    {s.state === "held" ? "Release" : "Approve"}
                  </Action>
                  {s.state === "awaiting_approval" && (
                    <Action className="btn" disabled={!actions.canRelease(s)} onClick={() => actions.holdGate(s)}>
                      Hold
                    </Action>
                  )}
                  <Action className="btn link" onClick={() => actions.validate(s)}>
                    Validate
                  </Action>
                </>
              )}
              {s.state === "running" && can("operator") && (
                <>
                  <button type="button" className="btn accent" onClick={() => setRecord(s)}>
                    Record units
                  </button>
                  <button type="button" className="btn" onClick={() => setHold(s)}>
                    Hold
                  </button>
                </>
              )}
            </div>
            <button type="button" className="link right" onClick={() => (setDrawer(s.code), setSel(null))}>
              Full details →
            </button>
          </div>
        )}
      </div>

      <section className="section">
        <div className="section-h">
          <h2>Decision stream</h2>
          <span className="muted small">What the agents and people decided on this run, and why</span>
        </div>
        <div className="stream">
          {decisions.slice(0, 40).map((d) => (
            <div key={d.id} className="row">
              <span className="faint">{time(d.ts)}</span>
              <span className="agent">{actorLabel(d.agent, names)}</span>
              <span>
                <b>{d.summary}</b>
                {d.reason && <span className="muted"> — {d.reason}</span>}
              </span>
              <span className="faint r">{d.confidence !== null ? `conf. ${d.confidence.toFixed(2)}` : d.stageCode ?? ""}</span>
            </div>
          ))}
        </div>
      </section>

      <StageDrawer run={run} stage={stage(drawer)} decisions={decisions} inbox={inbox} onClose={() => setDrawer(null)} actions={actions} onRecord={setRecord} onHold={setHold} />
      <RecordModal run={run} stage={record} onClose={() => setRecord(null)} onDone={async () => (await load(), await refresh())} />
      <HoldModal stage={hold} onClose={() => setHold(null)} onHold={(reason) => actions.holdRunning(hold!, reason)} />
      <AutonomyModal open={autonomy} onClose={() => setAutonomy(false)} lineId={line.id} current={line.autonomy} />
    </div>
  );
}

export function AutonomyModal({ open, onClose, lineId, current }: { open: boolean; onClose: () => void; lineId: string; current: AutonomyLevel }) {
  const { path, can, reloadSite } = useApp();
  const sign = useSign();
  const [level, setLevel] = useState<AutonomyLevel>(current);
  const [comment, setComment] = useState("");
  useEffect(() => setLevel(current), [current, open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Line autonomy"
      title="How much may agents do on their own?"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={!can("plant_manager") || level === current}
            onClick={async () => {
              const r = await sign({
                title: `Set autonomy to ${level} · ${LEVEL_LABEL[level]}`,
                request: (chainId) => api.post<TypedSignature>(path(`/lines/${lineId}/autonomy/sign-request`), { level, comment, chainId }),
                submit: (proof) => api.put(path(`/lines/${lineId}/autonomy`), { level, comment, ...proof }),
              });
              if (r) {
                await reloadSite();
                onClose();
              }
            }}
          >
            Sign and apply
          </Action>
        </div>
      }
    >
      <div className="levels">
        {(["L1", "L2", "L3", "L4"] as AutonomyLevel[]).map((l) => (
          <button type="button" key={l} className={`level${l === level ? " on" : ""}`} onClick={() => setLevel(l)} disabled={!can("plant_manager")}>
            <b>
              {l} · {LEVEL_LABEL[l]}
            </b>
            <span className="muted small">{LEVEL_TEXT[l]}</span>
          </button>
        ))}
      </div>
      <Field label="Reason (signed with the change)">
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
      </Field>
      {!can("plant_manager") && <p className="field-e">Only a plant manager can change autonomy.</p>}
    </Modal>
  );
}

function StartRun({ open, templateId, onClose, onStarted, path }: { open: boolean; templateId: string | null; onClose: () => void; onStarted: (id: string) => void; path: (p: string) => string }) {
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [tpl, setTpl] = useState<string | null>(null);
  const [order, setOrder] = useState("");
  const [qty, setQty] = useState("100");
  const [due, setDue] = useState<string | null>(null);
  const { live } = useApp();
  useEffect(() => {
    if (!open) return;
    void api.get<TemplateView[]>(path("/templates")).then((t) => {
      setTemplates(t);
      setTpl(templateId ?? t[0]?.id ?? null);
    });
  }, [open, path, templateId]);
  const t = templates.find((x) => x.id === tpl);
  const kinds = new Set((live?.assets ?? []).map((a) => a.kind));
  const missing = t ? [...new Set(t.spec.stages.filter((s) => s.resourceKind !== "system" && !kinds.has(s.resourceKind)).map((s) => s.resourceKind))] : [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="New run"
      title="Start a pipeline run"
      width={620}
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={!t || !order.trim() || !(Number(qty) > 0)}
            onClick={async () => {
              const r = await api.post<RunView>(path("/runs"), { templateVersionId: t!.versionId, orderRef: order.trim(), quantity: Number(qty), dueAt: due });
              onStarted(r.id);
            }}
          >
            Start run
          </Action>
        </div>
      }
    >
      <Field label="Template">
        <Select
          value={tpl}
          onChange={setTpl}
          options={templates.map((x) => ({ value: x.id, label: x.name, hint: `${x.origin === "custom" ? "Custom" : "Library"} · v${x.version} · ${x.spec.stages.length} stages`, group: x.category }))}
          searchable
        />
      </Field>
      {t && <p className="muted small">{t.description}</p>}
      <div className="form-grid two">
        <Field label="Order or batch reference">
          <input className="input" value={order} onChange={(e) => setOrder(e.target.value)} placeholder="e.g. SO-48213" />
        </Field>
        <Field label="Quantity (units)">
          <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
      </div>
      <Field label="Due (optional)" hint="Used for the ETA and on-track indicator.">
        <DateTimePicker value={due} onChange={setDue} clearable />
      </Field>
      {missing.length > 0 && (
        <div className="notice warn">
          No registered asset of kind: <b>{missing.join(", ").replaceAll("_", " ")}</b>. Those stages will wait for an operator to record them. <a href={href("floor")}>Register assets</a>
        </div>
      )}
    </Modal>
  );
}
