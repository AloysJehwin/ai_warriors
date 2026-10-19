import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { AGENT_LABEL } from "../lib/format";
import { go, useRoute } from "../lib/router";
import type { AgentKey, AssetKind, Criterion, Role, StageSpec, TemplateView } from "../types";
import { Action, Field, Loading, Modal, Segmented, useToast } from "../ui/kit";
import { Select } from "../ui/Select";

interface Draft extends Omit<StageSpec, "code"> {
  key: number;
}
type Mode = StageSpec["mode"];
let seq = 1;
const KIND_LABEL: Record<AssetKind, string> = {
  cnc: "CNC machine",
  robot: "Robot cell",
  manual_station: "Manual station",
  inspection: "Inspection station",
  agv: "AGV fleet",
  pack_line: "Pack line",
  process_vessel: "Vessel / oven",
  maintenance_crew: "Maintenance crew",
  system: "ERP / MES link",
};
const PALETTE: { name: string; agent: AgentKey; resourceKind: AssetKind; mode: Mode; escalationRole: Role }[] = [
  { name: "Order intake", agent: "planning", resourceKind: "system", mode: "auto", escalationRole: "supervisor" },
  { name: "Material sourcing", agent: "supply", resourceKind: "agv", mode: "auto", escalationRole: "supervisor" },
  { name: "Machining", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "supervisor" },
  { name: "Assembly", agent: "line", resourceKind: "robot", mode: "auto", escalationRole: "supervisor" },
  { name: "Manual assembly", agent: "line", resourceKind: "manual_station", mode: "manual", escalationRole: "supervisor" },
  { name: "Heat treatment", agent: "process", resourceKind: "process_vessel", mode: "auto", escalationRole: "process_engineer" },
  { name: "Quality inspection", agent: "vision_qa", resourceKind: "inspection", mode: "approve", escalationRole: "quality_engineer" },
  { name: "Functional test", agent: "vision_qa", resourceKind: "inspection", mode: "auto", escalationRole: "quality_engineer" },
  { name: "Packaging", agent: "logistics", resourceKind: "pack_line", mode: "auto", escalationRole: "supervisor" },
  { name: "Dispatch", agent: "logistics", resourceKind: "agv", mode: "auto", escalationRole: "supervisor" },
  { name: "Maintenance check", agent: "maintenance", resourceKind: "maintenance_crew", mode: "manual", escalationRole: "maintenance_lead" },
];

/** Codes from columns: one stage → "05", several → "05a", "05b". */
function withCodes(stages: Draft[]): (Draft & { code: string })[] {
  const cols = [...new Set(stages.map((s) => s.column))].sort((a, b) => a - b);
  const out: (Draft & { code: string })[] = [];
  cols.forEach((c, i) => {
    const g = stages.filter((s) => s.column === c);
    g.forEach((s, j) => out.push({ ...s, column: i + 1, code: `${String(i + 1).padStart(2, "0")}${g.length > 1 ? String.fromCharCode(97 + j) : ""}` }));
  });
  return out;
}
const fromSpec = (t: TemplateView): Draft[] => t.spec.stages.map((s) => ({ ...s, key: seq++ }));

export function Builder() {
  const { path, can, meta } = useApp();
  const route = useRoute();
  const toast = useToast();
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [base, setBase] = useState<TemplateView | null>(null);
  const [stages, setStages] = useState<Draft[]>([]);
  const [rework, setRework] = useState<{ from: number; to: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Discrete");
  const [description, setDescription] = useState("");
  const [publish, setPublish] = useState(false);
  const [note, setNote] = useState("");
  const editable = can("process_engineer");

  useEffect(() => {
    void api.get<TemplateView[]>(path("/templates")).then((t) => {
      setTemplates(t);
      const pick = t.find((x) => x.id === route.id) ?? null;
      load(pick);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, route.id]);
  const load = (t: TemplateView | null) => {
    setBase(t);
    if (!t) {
      setStages([]);
      setRework(null);
      setName("New pipeline");
      setDescription("");
      return;
    }
    const d = fromSpec(t);
    setStages(d);
    const codes = withCodes(d);
    setRework(t.spec.rework ? { from: codes.find((c) => c.code === t.spec.rework!.from)!.key, to: codes.find((c) => c.code === t.spec.rework!.to)!.key } : null);
    setName(t.name);
    setCategory(t.category);
    setDescription(t.description);
    setSelected(d[0]?.key ?? null);
  };
  const coded = useMemo(() => withCodes(stages), [stages]);
  const columns = useMemo(() => {
    const m = new Map<number, (Draft & { code: string })[]>();
    for (const s of coded) m.set(s.column, [...(m.get(s.column) ?? []), s]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [coded]);
  const sel = coded.find((s) => s.key === selected) ?? null;
  const maxCol = Math.max(0, ...stages.map((s) => s.column));
  const update = (key: number, patch: Partial<Draft>) => setStages(stages.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const add = (p: (typeof PALETTE)[number]) => {
    const key = seq++;
    // criteria seeded from the library defaults for that agent (taken from any template that uses it)
    const crit = templates?.flatMap((t) => t.spec.stages).find((s) => s.agent === p.agent)?.criteria ?? [];
    setStages([...stages, { ...p, key, column: maxCol + 1, timeoutMin: 60, criteria: crit }]);
    setSelected(key);
  };
  // Move a stage one column left/right; "parallel" puts it in the same column as its neighbour.
  const move = (key: number, dir: -1 | 1) => {
    const s = stages.find((x) => x.key === key)!;
    const alone = stages.filter((x) => x.column === s.column).length === 1;
    const target = s.column + dir;
    if (target < 1) return;
    if (alone) {
      // swap whole columns
      setStages(stages.map((x) => (x.key === key ? { ...x, column: target } : x.column === target ? { ...x, column: s.column } : x)));
    } else {
      // leave the parallel group into its own new column next to it
      const shift = dir === 1 ? s.column : s.column - 1;
      setStages(stages.map((x) => (x.key === key ? { ...x, column: shift + 0.5 } : x)).map((x) => ({ ...x, column: x.column })).sort((a, b) => a.column - b.column));
    }
  };
  const parallel = (key: number, dir: -1 | 1) => {
    const s = stages.find((x) => x.key === key)!;
    const cols = [...new Set(stages.map((x) => x.column))].sort((a, b) => a - b);
    const idx = cols.indexOf(s.column) + dir;
    if (idx < 0 || idx >= cols.length) return;
    update(key, { column: cols[idx]! });
  };
  const remove = (key: number) => {
    setStages(stages.filter((s) => s.key !== key));
    if (rework && (rework.from === key || rework.to === key)) setRework(null);
    setSelected(null);
  };

  const spec = () => ({
    stages: coded.map(({ key: _k, ...s }) => s),
    rework: rework ? { from: coded.find((c) => c.key === rework.from)!.code, to: coded.find((c) => c.key === rework.to)!.code } : null,
  });
  const errors: string[] = [];
  if (!stages.length) errors.push("Add at least one stage");
  if (rework) {
    const f = coded.find((c) => c.key === rework.from);
    const t = coded.find((c) => c.key === rework.to);
    if (!f || !t || t.column >= f.column) errors.push("The rework loop must send units back to an earlier stage");
  }

  if (!templates) return <Loading />;
  return (
    <div className="builder">
      <div className="page-head">
        <div className="ph-text">
          <div className="eyebrow">{base ? `${base.origin === "library" ? "Draft · based on" : `Editing v${base.version} of`} ${base.name}` : "Draft · new pipeline"}</div>
          <h1>Pipeline builder</h1>
        </div>
        <div className="ph-actions">
          <Select
            width={280}
            value={base?.id ?? "__new"}
            onChange={(id) => go(id === "__new" ? "builder" : `builder/${id}`)}
            options={[{ value: "__new", label: "Blank pipeline", group: "New" }, ...templates.map((t) => ({ value: t.id, label: t.name, hint: t.origin === "custom" ? `v${t.version}` : "Library", group: t.category }))]}
            searchable
          />
          <button type="button" className="btn" onClick={() => load(base)}>
            Reset
          </button>
          {editable && (
            <button type="button" className="btn accent" disabled={errors.length > 0} onClick={() => setPublish(true)} title={errors.join("; ")}>
              Publish pipeline
            </button>
          )}
        </div>
      </div>
      <div className="b-grid">
        <aside className="palette">
          <span className="label">Add stage</span>
          {PALETTE.map((p) => (
            <button type="button" key={p.name} className="pal" disabled={!editable} onClick={() => add(p)}>
              + {p.name}
              <span className="faint small">{AGENT_LABEL[p.agent]}</span>
            </button>
          ))}
        </aside>
        <div className="b-canvas">
          <p className="muted small">Columns run left to right; stages stacked in a column run in parallel. Equal lane counts continue lane by lane, otherwise lanes split or merge.</p>
          <div className="b-cols">
            {columns.map(([col, list], i) => (
              <div key={col} className="b-colwrap">
                <div className="b-col">
                  {list.map((s) => (
                    <button type="button" key={s.key} className={`b-card${s.key === selected ? " on" : ""}`} onClick={() => setSelected(s.key)}>
                      <span className="label">Stage {s.code}</span>
                      <b>{s.name}</b>
                      <span className="faint small">{KIND_LABEL[s.resourceKind]}</span>
                      <span className={`tag ${s.mode === "approve" ? "accent" : ""}`}>{s.mode === "auto" ? "Auto" : s.mode === "approve" ? "Approve" : "Manual"}</span>
                    </button>
                  ))}
                </div>
                {i < columns.length - 1 && <span className="b-arrow">→</span>}
              </div>
            ))}
            {!stages.length && <p className="faint">Add stages from the palette.</p>}
          </div>
          <div className="rework-edit">
            <span className="label">Rework loop</span>
            <Select size="sm" width={220} value={rework ? String(rework.from) : null} onChange={(v) => setRework({ from: Number(v), to: rework?.to ?? coded[0]!.key })} options={coded.map((s) => ({ value: String(s.key), label: `From ${s.code} ${s.name}` }))} placeholder="No rework loop" />
            <Select size="sm" width={220} value={rework ? String(rework.to) : null} onChange={(v) => rework && setRework({ ...rework, to: Number(v) })} options={coded.map((s) => ({ value: String(s.key), label: `back to ${s.code} ${s.name}` }))} placeholder="back to…" disabled={!rework} />
            {rework && (
              <button type="button" className="link" onClick={() => setRework(null)}>
                Remove loop
              </button>
            )}
          </div>
          {errors.length > 0 && stages.length > 0 && <p className="field-e">{errors.join(". ")}</p>}
          <div className="form-grid three">
            <Field label="Pipeline name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} />
            </Field>
            <Field label="Category">
              <Select value={category} onChange={setCategory} options={[...new Set([...meta.categories, category])].map((c) => ({ value: c, label: c }))} />
            </Field>
            <Field label="Description">
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} />
            </Field>
          </div>
        </div>
        <aside className="inspector">
          {sel ? (
            <StageInspector
              key={sel.key}
              s={sel}
              editable={editable}
              meta={meta}
              onChange={(p) => update(sel.key, p)}
              onMove={(d) => move(sel.key, d)}
              onParallel={(d) => parallel(sel.key, d)}
              onRemove={() => remove(sel.key)}
            />
          ) : (
            <p className="faint">Select a stage to configure its agent, resource, gate and success criteria.</p>
          )}
        </aside>
      </div>
      <Modal
        open={publish}
        onClose={() => setPublish(false)}
        title="Publish pipeline"
        eyebrow={base?.origin === "custom" ? `New version of ${base.name}` : "New template for this site"}
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setPublish(false)}>
              Cancel
            </button>
            <Action
              className="btn accent"
              onClick={async () => {
                const t = await api.post<TemplateView>(path("/templates"), { templateId: base?.id, name, category, description, spec: spec(), note: note || undefined });
                toast(`Published ${t.name} v${t.version}`, "ok");
                setPublish(false);
                go(`builder/${t.id}`);
              }}
            >
              Publish
            </Action>
          </div>
        }
      >
        <p className="muted">Publishing creates a new immutable template version. Runs already in progress keep the version they started with. The spec hash is written to the ledger.</p>
        <Field label="Change note">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="What changed and why" />
        </Field>
      </Modal>
    </div>
  );
}

function StageInspector(props: { s: Draft & { code: string }; editable: boolean; meta: ReturnType<typeof useApp>["meta"]; onChange: (p: Partial<Draft>) => void; onMove: (d: -1 | 1) => void; onParallel: (d: -1 | 1) => void; onRemove: () => void }) {
  const { s, editable, meta } = props;
  const setCrit = (i: number, p: Partial<Criterion>) => props.onChange({ criteria: s.criteria.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  return (
    <div className="insp">
      <div className="insp-h">
        <h2>Stage {s.code}</h2>
        {editable && (
          <span className="btns">
            <button type="button" className="icon-btn" title="Earlier column" onClick={() => props.onMove(-1)}>
              ←
            </button>
            <button type="button" className="icon-btn" title="Later column" onClick={() => props.onMove(1)}>
              →
            </button>
            <button type="button" className="link danger" onClick={props.onRemove}>
              Remove
            </button>
          </span>
        )}
      </div>
      {editable && (
        <div className="btns small">
          <button type="button" className="link" onClick={() => props.onParallel(-1)}>
            Run in parallel with previous
          </button>
          <button type="button" className="link" onClick={() => props.onParallel(1)}>
            … with next
          </button>
        </div>
      )}
      <fieldset disabled={!editable} className="plain">
        <Field label="Stage name">
          <input className="input" value={s.name} onChange={(e) => props.onChange({ name: e.target.value })} />
        </Field>
        <Field label="Assigned resource">
          <Select value={s.resourceKind} onChange={(v) => props.onChange({ resourceKind: v as AssetKind })} options={meta.assetKinds.map((k) => ({ value: k.key, label: KIND_LABEL[k.key as AssetKind] ?? k.label }))} disabled={!editable} />
        </Field>
        <Field label="Agent">
          <Select<AgentKey> value={s.agent} onChange={(v) => props.onChange({ agent: v })} options={meta.agents.map((a) => ({ value: a.key, label: a.label, hint: a.scope }))} disabled={!editable} />
        </Field>
        <Field label="Execution mode" hint={s.mode === "auto" ? "Agent runs the stage and advances on success criteria." : s.mode === "approve" ? "Agent prepares and recommends; a person signs off before advancing." : "A person executes; the agent tracks and records."}>
          <Segmented<Mode>
            value={s.mode}
            onChange={(m) => editable && props.onChange({ mode: m })}
            options={[
              { value: "auto", label: "Auto" },
              { value: "approve", label: "Approve" },
              { value: "manual", label: "Manual" },
            ]}
          />
        </Field>
        <div className="section-h spread">
          <span className="field-l">Success criteria</span>
          {editable && (
            <button type="button" className="link" onClick={() => props.onChange({ criteria: [...s.criteria, { label: "Yield", op: ">=", target: 98, unit: "%" }] })}>
              + Add
            </button>
          )}
        </div>
        {s.criteria.map((c, i) => (
          <div key={i} className="crit">
            <input className="input sm" value={c.label} onChange={(e) => setCrit(i, { label: e.target.value })} />
            <Select size="sm" width={58} value={c.op} onChange={(v) => setCrit(i, { op: v as Criterion["op"] })} options={[">=", "<=", "=="].map((o) => ({ value: o, label: o === ">=" ? "≥" : o === "<=" ? "≤" : "=" }))} searchable={false} disabled={!editable} />
            <input className="input sm num" type="number" value={c.target} onChange={(e) => setCrit(i, { target: Number(e.target.value) })} />
            <input className="input sm unit" value={c.unit} onChange={(e) => setCrit(i, { unit: e.target.value })} />
            {editable && (
              <button type="button" className="icon-btn" aria-label="Remove" onClick={() => props.onChange({ criteria: s.criteria.filter((_, j) => j !== i) })}>
                ×
              </button>
            )}
          </div>
        ))}
        <p className="faint small">Yield, scrap, defects (ppm), cycle time and OEE are measured automatically. Other criteria need a person to confirm them at the gate.</p>
        <div className="form-grid two">
          <Field label="Timeout (min)">
            <input className="input" type="number" min={1} value={s.timeoutMin} onChange={(e) => props.onChange({ timeoutMin: Math.max(1, Number(e.target.value)) })} />
          </Field>
          <Field label="Escalate to">
            <Select<Role> value={s.escalationRole} onChange={(v) => props.onChange({ escalationRole: v })} options={meta.roles.filter((r) => r.key !== "admin").map((r) => ({ value: r.key, label: r.label }))} disabled={!editable} />
          </Field>
        </div>
      </fieldset>
    </div>
  );
}
