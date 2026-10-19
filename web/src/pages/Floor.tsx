import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, AGENT_LABEL, dateTime, LEVEL_LABEL, pct, signalLabel, STATUS_LABEL } from "../lib/format";
import { href, useRoute } from "../lib/router";
import type { AgentKey, AgentRow, AssetKind, AssetView, DataSource, Incident, SignalLimit } from "../types";
import { Action, Drawer, Empty, Field, Loading, Menu, Modal, Segmented, Tabs, useToast } from "../ui/kit";
import { Select } from "../ui/Select";
import { Spark } from "../ui/Spark";

type Tab = "assets" | "agents" | "incidents";
const SIGNALS = ["temperature", "load_pct", "spindle_speed", "vibration", "feed_override", "part_count", "execution", "good", "scrap"];
const statusClass = (s: string) => (s === "running" ? "ok" : s === "alarm" ? "bad" : s === "degraded" ? "warn" : s === "offline" || s === "no_data" ? "muted" : "");

export function Floor() {
  const { live, can, site } = useApp();
  const route = useRoute();
  const [tab, setTab] = useState<Tab>((route.id as Tab) || "assets");
  const [edit, setEdit] = useState<AssetView | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!live) return <Loading />;
  const zones = [...site.zones.map((z) => ({ id: z.id as string | null, name: z.name })), { id: null, name: "No zone" }];
  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <div className="eyebrow">
            {live.assets.length} assets · {live.assets.filter((a) => a.status === "running").length} running
          </div>
          <h1>Floor & fleet</h1>
        </div>
        <div className="ph-actions">
          {can("process_engineer") || can("maintenance_lead") ? (
            <button type="button" className="btn accent" onClick={() => setEdit("new")}>
              Add asset
            </button>
          ) : null}
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "assets", label: "Assets", count: live.assets.length },
          { value: "agents", label: "Agents" },
          { value: "incidents", label: "Incidents" },
        ]}
      />
      {tab === "assets" &&
        (live.assets.length === 0 ? (
          <Empty title="No assets registered" action={can("process_engineer") || can("maintenance_lead") ? <button type="button" className="btn accent" onClick={() => setEdit("new")}>Add your first asset</button> : undefined}>
            Connect a machine through its MTConnect agent, upload a real dataset as CSV, or record readings by hand. Ordo shows only what it measures: until data arrives an asset reads “No data yet”.
          </Empty>
        ) : (
          zones.map((z) => {
            const list = live.assets.filter((a) => a.zoneId === z.id);
            if (!list.length) return null;
            return (
              <section key={z.id ?? "none"} className="section">
                <div className="section-h">
                  <h2>{z.name}</h2>
                  <span className="muted small">{list.length} assets</span>
                </div>
                <div className="card scroll-x">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Status</th>
                        <th>Current job</th>
                        <th className="r">Utilization 1 h</th>
                        <th className="r">OEE</th>
                        <th>Owning agent</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((a) => (
                        <tr key={a.id} className="click" onClick={() => setOpen(a.id)}>
                          <td>
                            <b>{a.name}</b>
                            <div className="faint small">{a.kind.replaceAll("_", " ")}</div>
                          </td>
                          <td>
                            <span className={`pill ${statusClass(a.status)}`}>
                              <span className="dot" /> {STATUS_LABEL[a.status]}
                            </span>
                            <div className="faint small">{a.statusDetail}</div>
                          </td>
                          <td>{a.currentJob ?? <span className="faint">—</span>}</td>
                          <td className="r">{pct(a.utilization, 0)}</td>
                          <td className="r">{pct(a.oee, 0)}</td>
                          <td className="agent">{AGENT_LABEL[a.owningAgent]}</td>
                          <td className="small">
                            {a.source.type === "mtconnect" ? "MTConnect" : a.source.type === "replay" ? "Dataset" : "Manual"}
                            <div className={a.sourceError ? "bad-text small" : "faint small"}>{a.sourceError ? "error" : `data ${ago(a.lastDataAt)}`}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })
        ))}
      {tab === "agents" && <Agents />}
      {tab === "incidents" && <Incidents />}
      {edit && <AssetForm asset={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      {open && <AssetDrawer id={open} onClose={() => setOpen(null)} onEdit={(a) => (setOpen(null), setEdit(a))} />}
    </div>
  );
}

function Agents() {
  const { path, live } = useApp();
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  useEffect(() => {
    void api.get<AgentRow[]>(path("/agents")).then(setRows);
  }, [path, live?.headSeq]);
  if (!rows) return <Loading />;
  return (
    <div className="card scroll-x section">
      <table className="t">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Scope</th>
            <th>Autonomy</th>
            <th>Current task</th>
            <th className="r">Decisions 24 h</th>
            <th className="r">Escalations</th>
            <th className="r">Avg. confidence</th>
            <th>Assets</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.key}>
              <td>
                <b>{a.label}</b>
                {a.inft && (
                  <div className="small" title={a.inft.data.map((d) => `${d.dataDescription} · ${d.dataHash.slice(0, 10)}…`).join("\n")}>
                    {a.inft.tokenId === null ? (
                      <span className={a.inft.status === "failed" ? "field-e" : "faint"}>{a.inft.status === "failed" ? `iNFT mint failed: ${a.inft.error}` : "minting iNFT on 0G…"}</span>
                    ) : (
                      <a href={a.inft.url ?? a.inft.txUrl ?? undefined} target="_blank" rel="noreferrer">
                        iNFT #{a.inft.tokenId}
                        {a.inft.status === "pending" ? " · updating" : ""}
                      </a>
                    )}
                  </div>
                )}
              </td>
              <td className="muted">{a.scope}</td>
              <td>
                {a.autonomy} · {LEVEL_LABEL[a.autonomy]}
              </td>
              <td>
                {a.currentTask ?? <span className="faint">idle</span>}
                {a.activeStages > 1 && <span className="faint small"> +{a.activeStages - 1}</span>}
              </td>
              <td className="r">{a.decisionsToday}</td>
              <td className="r">{a.escalationsToday}</td>
              <td className="r">{a.avgConfidence === null ? "—" : a.avgConfidence.toFixed(2)}</td>
              <td className="small">{a.assets.length ? a.assets.map((x) => x.name).join(", ") : <span className="faint">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Incidents() {
  const { path, live } = useApp();
  const [rows, setRows] = useState<Incident[] | null>(null);
  useEffect(() => {
    void api.get<Incident[]>(path("/incidents")).then(setRows);
  }, [path, live?.headSeq]);
  if (!rows) return <Loading />;
  if (!rows.length) return <Empty title="No incidents">Agents open an incident when a signal crosses a limit you set on an asset, drifts toward it, or the controller reports a fault.</Empty>;
  return (
    <div className="card scroll-x section">
      <table className="t">
        <thead>
          <tr>
            <th>Incident</th>
            <th>Severity</th>
            <th>Opened</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id}>
              <td>
                <b className="mono">{i.id}</b> {i.title}
              </td>
              <td>
                <span className={`tag ${i.severity === "alarm" ? "bad" : "warn"}`}>{i.severity}</span>
              </td>
              <td>{dateTime(i.openedAt)}</td>
              <td>{i.status === "closed" ? `closed ${dateTime(i.closedAt)}` : i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface AssetDetail {
  view: AssetView;
  series: Record<string, { ts: number; value: number | null }[]>;
  replays: { id: string; name: string; rows: number; durationMs: number; speed: number; startedAt: string | null; createdAt: string }[];
}

function AssetDrawer({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (a: AssetView) => void }) {
  const { path, live, can, refresh } = useApp();
  const [d, setD] = useState<AssetDetail | null>(null);
  const [minutes, setMinutes] = useState("60");
  const [reading, setReading] = useState(false);
  const [upload, setUpload] = useState(false);
  const toast = useToast();
  const load = () => api.get<AssetDetail>(path(`/assets/${id}?minutes=${minutes}`)).then(setD);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, minutes, live?.headSeq]);
  if (!d) return null;
  const a = d.view;
  const src = a.source as DataSource;
  return (
    <Drawer
      open
      onClose={onClose}
      width={560}
      eyebrow={`${a.kind.replaceAll("_", " ")} · ${AGENT_LABEL[a.owningAgent]}`}
      title={a.name}
      actions={
        can("process_engineer") || can("maintenance_lead") ? (
          <Menu
            trigger={(_o, t) => (
              <button type="button" className="btn sm" onClick={t}>
                Manage
              </button>
            )}
            items={[
              { label: "Edit asset", onClick: () => onEdit(a) },
              { label: "Upload dataset (CSV)", onClick: () => setUpload(true) },
              {
                label: "Archive asset",
                danger: true,
                onClick: async () => {
                  if (!confirm(`Archive ${a.name}? Its data stays in the ledger.`)) return;
                  await api.del(path(`/assets/${a.id}`));
                  toast("Archived", "ok");
                  onClose();
                  await refresh();
                },
              },
            ]}
          />
        ) : undefined
      }
    >
      <div className="status-line">
        <span className={`pill ${statusClass(a.status)}`}>
          <span className="dot" /> {STATUS_LABEL[a.status]}
        </span>
        <span className="muted small">{a.statusDetail}</span>
      </div>
      <dl className="kv">
        <dt>Source</dt>
        <dd>
          {src.type === "mtconnect" ? (
            <>
              MTConnect · <span className="mono small">{src.agentUrl}</span> · device <b>{src.device}</b> · every {src.pollSeconds}s
            </>
          ) : src.type === "replay" ? (
            "Uploaded dataset replay"
          ) : (
            "Manual readings"
          )}
        </dd>
        <dt>Last data</dt>
        <dd>{a.lastDataAt ? `${dateTime(a.lastDataAt)} (${ago(a.lastDataAt)})` : "none yet"}</dd>
        {a.sourceError && (
          <>
            <dt>Source error</dt>
            <dd className="bad-text">{a.sourceError}</dd>
          </>
        )}
        <dt>Utilization 1 h</dt>
        <dd>{pct(a.utilization, 0)}</dd>
        <dt>OEE</dt>
        <dd>{pct(a.oee, 0)}</dd>
        <dt>Current job</dt>
        <dd>{a.currentJob ?? "—"}</dd>
      </dl>
      <div className="section-h spread">
        <h3>Signals</h3>
        <Segmented
          size="sm"
          value={minutes}
          onChange={setMinutes}
          options={[
            { value: "60", label: "1 h" },
            { value: "480", label: "8 h" },
            { value: "1440", label: "24 h" },
          ]}
        />
      </div>
      {Object.keys(a.latest).length === 0 && <p className="faint">No readings yet.</p>}
      <div className="signals">
        {Object.entries(a.latest)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([k, v]) => {
            const lim = a.limits[k];
            const over = v.value !== null && lim && ((lim.alarm !== undefined && v.value >= lim.alarm) || (lim.warn !== undefined && v.value >= lim.warn));
            return (
              <div key={k} className="signal">
                <div className="sig-h">
                  <span>{signalLabel(k)}</span>
                  <b className={over ? "bad-text" : ""}>
                    {v.value ?? v.text}
                    {lim?.unit && v.value !== null ? ` ${lim.unit}` : ""}
                  </b>
                </div>
                {d.series[k] && v.value !== null && <Spark points={d.series[k]!} warn={lim?.warn} alarm={lim?.alarm} unit={lim?.unit} />}
                <div className="faint small">
                  {lim ? `warn ${lim.warn ?? "—"} · alarm ${lim.alarm ?? "—"}` : "no limits"} · {v.quality} · {ago(v.ts)}
                </div>
              </div>
            );
          })}
      </div>
      {can("operator") && (
        <div className="btns">
          <button type="button" className="btn" onClick={() => setReading(true)}>
            Record a reading
          </button>
        </div>
      )}
      {d.replays.length > 0 && (
        <section className="dsec">
          <h3>Datasets</h3>
          {d.replays.map((r) => (
            <div key={r.id} className="replay">
              <span>
                <b>{r.name}</b>
                <span className="faint small">
                  {" "}
                  · {r.rows} points · {(r.durationMs / 60_000).toFixed(1)} min{r.startedAt ? ` · playing at ${r.speed}× since ${dateTime(r.startedAt)}` : ""}
                </span>
              </span>
              <ReplayStart assetId={a.id} seriesId={r.id} onDone={load} />
            </div>
          ))}
        </section>
      )}
      {reading && <ReadingModal assetId={a.id} onClose={() => setReading(false)} onDone={load} />}
      {upload && <UploadModal assetId={a.id} onClose={() => setUpload(false)} onDone={load} />}
    </Drawer>
  );
}

function ReplayStart({ assetId, seriesId, onDone }: { assetId: string; seriesId: string; onDone: () => Promise<unknown> }) {
  const { path, refresh } = useApp();
  const [speed, setSpeed] = useState("1");
  return (
    <div className="btns">
      <Select
        size="sm"
        width={92}
        value={speed}
        onChange={setSpeed}
        options={["1", "2", "5", "10", "60"].map((s) => ({ value: s, label: `${s}×` }))}
        searchable={false}
      />
      <Action
        className="btn sm"
        onClick={async () => {
          await api.post(path(`/assets/${assetId}/replays/${seriesId}/start`), { speed: Number(speed) });
          await onDone();
          await refresh();
        }}
      >
        Play
      </Action>
    </div>
  );
}

function ReadingModal({ assetId, onClose, onDone }: { assetId: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { path, refresh } = useApp();
  const [signal, setSignal] = useState("temperature");
  const [value, setValue] = useState("");
  const textual = ["execution", "availability", "program"].includes(signal);
  return (
    <Modal
      open
      onClose={onClose}
      title="Record a reading"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={!value.trim()}
            onClick={async () => {
              await api.post(path(`/assets/${assetId}/readings`), textual ? { signal, text: value.trim() } : { signal, value: Number(value) });
              onClose();
              await onDone();
              await refresh();
            }}
          >
            Record
          </Action>
        </div>
      }
    >
      <div className="form-grid two">
        <Field label="Signal">
          <Select value={signal} onChange={setSignal} options={[...SIGNALS, "availability", "program"].map((s) => ({ value: s, label: signalLabel(s) }))} />
        </Field>
        <Field label={textual ? "Value (text)" : "Value"} hint={signal === "execution" ? "ACTIVE, READY, STOPPED, INTERRUPTED…" : undefined}>
          {signal === "execution" ? (
            <Select value={value || null} onChange={setValue} options={["ACTIVE", "READY", "STOPPED", "INTERRUPTED", "FEED_HOLD"].map((s) => ({ value: s, label: s }))} />
          ) : (
            <input className="input" type={textual ? "text" : "number"} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          )}
        </Field>
      </div>
    </Modal>
  );
}

function UploadModal({ assetId, onClose, onDone }: { assetId: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { path } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const toast = useToast();
  return (
    <Modal
      open
      onClose={onClose}
      title="Upload a dataset"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={!file}
            onClick={async () => {
              const r = await api.text<{ rows: number; signals: string[] }>(path(`/assets/${assetId}/replays?name=${encodeURIComponent(file!.name)}`), await file!.text());
              toast(`Loaded ${r.rows} points: ${r.signals.join(", ")}`, "ok");
              onClose();
              await onDone();
            }}
          >
            Upload
          </Action>
        </div>
      }
    >
      <p className="muted">
        A CSV recorded from a real machine. Long format <span className="mono">time,signal,value</span> or wide format <span className="mono">time,temperature,load_pct,…</span>. Time is seconds from start or a timestamp. After upload, play it back at the speed you choose; agents and runs treat it like a live source.
      </p>
      <label className="drop">
        <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file ? (
          <>
            <b>{file.name}</b> · {(file.size / 1024).toFixed(1)} KB
          </>
        ) : (
          "Choose a CSV file (max 4 MB)"
        )}
      </label>
    </Modal>
  );
}

type LimitRow = { signal: string; warn: string; alarm: string; unit: string };

function AssetForm({ asset, onClose }: { asset: AssetView | null; onClose: () => void }) {
  const { path, meta, site, refresh } = useApp();
  const toast = useToast();
  const [name, setName] = useState(asset?.name ?? "");
  const [kind, setKind] = useState<AssetKind>(asset?.kind ?? "cnc");
  const [zone, setZone] = useState<string | null>(asset?.zoneId ?? site.zones[0]?.id ?? null);
  const [agent, setAgent] = useState<AgentKey>(asset?.owningAgent ?? "scheduler");
  const src0 = asset?.source;
  const [type, setType] = useState<DataSource["type"]>(src0?.type ?? "mtconnect");
  const [url, setUrl] = useState(src0?.type === "mtconnect" ? src0.agentUrl : "https://demo.mtconnect.org");
  const [device, setDevice] = useState<string | null>(src0?.type === "mtconnect" ? src0.device : null);
  const [devices, setDevices] = useState<{ name: string; model: string | null }[]>(src0?.type === "mtconnect" ? [{ name: src0.device, model: null }] : []);
  const [poll, setPoll] = useState(String(src0?.type === "mtconnect" ? src0.pollSeconds : 10));
  const [cycle, setCycle] = useState(asset ? "" : "");
  const [limits, setLimits] = useState<LimitRow[]>(
    asset ? Object.entries(asset.limits).map(([signal, l]) => ({ signal, warn: l.warn?.toString() ?? "", alarm: l.alarm?.toString() ?? "", unit: l.unit })) : [{ signal: "temperature", warn: "", alarm: "", unit: "°C" }],
  );
  const probing = useRef(false);
  const agentFor: Partial<Record<AssetKind, AgentKey>> = { cnc: "scheduler", robot: "line", manual_station: "line", inspection: "vision_qa", agv: "supply", pack_line: "logistics", process_vessel: "process", maintenance_crew: "maintenance", system: "planning" };

  const probe = async () => {
    if (probing.current) return;
    probing.current = true;
    try {
      const r = await api.post<{ devices: { name: string; model: string | null }[] }>(path("/assets/probe"), { agentUrl: url });
      setDevices(r.devices);
      setDevice(r.devices[0]?.name ?? null);
      toast(`Found ${r.devices.length} device(s)`, "ok");
    } finally {
      probing.current = false;
    }
  };
  const save = async () => {
    const lim: Record<string, SignalLimit> = {};
    for (const l of limits) {
      if (!l.signal.trim() || (l.warn === "" && l.alarm === "")) continue;
      lim[l.signal.trim()] = { ...(l.warn !== "" ? { warn: Number(l.warn) } : {}), ...(l.alarm !== "" ? { alarm: Number(l.alarm) } : {}), unit: l.unit };
    }
    const source: DataSource = type === "mtconnect" ? { type, agentUrl: url.trim(), device: device!, pollSeconds: Number(poll) } : type === "replay" ? { type } : { type: "manual" };
    const body = { name: name.trim(), kind, zoneId: zone, owningAgent: agent, source, limits: lim, idealCycleS: cycle ? Number(cycle) : null, description: null };
    if (asset) await api.put(path(`/assets/${asset.id}`), body);
    else await api.post(path("/assets"), body);
    toast(asset ? "Asset updated" : "Asset registered", "ok");
    onClose();
    await refresh();
  };
  return (
    <Modal
      open
      onClose={onClose}
      width={680}
      eyebrow={asset ? "Edit asset" : "Register asset"}
      title={asset ? asset.name : "Add an asset"}
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action className="btn accent" disabled={!name.trim() || (type === "mtconnect" && !device)} onClick={save}>
            {asset ? "Save" : "Register"}
          </Action>
        </div>
      }
    >
      <div className="form-grid two">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CNC-05" autoFocus />
        </Field>
        <Field label="Kind" hint="Stages are assigned to assets of the kind they need.">
          <Select
            value={kind}
            onChange={(k) => {
              setKind(k as AssetKind);
              const ag = agentFor[k as AssetKind];
              if (ag) setAgent(ag);
            }}
            options={meta.assetKinds.map((k) => ({ value: k.key, label: k.label }))}
          />
        </Field>
        <Field label="Zone">
          <Select value={zone} onChange={setZone} options={site.zones.map((z) => ({ value: z.id, label: z.name }))} placeholder="No zone" />
        </Field>
        <Field label="Owning agent">
          <Select<AgentKey> value={agent} onChange={setAgent} options={meta.agents.map((a) => ({ value: a.key, label: a.label, hint: a.scope }))} />
        </Field>
      </div>
      <Field label="Data source">
        <Segmented<DataSource["type"]>
          value={type}
          onChange={setType}
          options={[
            { value: "mtconnect", label: "MTConnect agent" },
            { value: "replay", label: "Dataset (CSV)" },
            { value: "manual", label: "Manual readings" },
          ]}
        />
      </Field>
      {type === "mtconnect" && (
        <div className="subform">
          <Field label="Agent URL" hint="The machine's MTConnect agent. Ordo reads /probe and /current over HTTP(S). Private network addresses are blocked from the cloud deployment.">
            <div className="inline">
              <input className="input grow" value={url} onChange={(e) => setUrl(e.target.value)} />
              <Action className="btn" onClick={probe}>
                Find devices
              </Action>
            </div>
          </Field>
          <div className="form-grid two">
            <Field label="Device">
              <Select value={device} onChange={setDevice} options={devices.map((d) => ({ value: d.name, label: d.name, hint: d.model ?? undefined }))} placeholder={devices.length ? "Choose device" : "Find devices first"} />
            </Field>
            <Field label="Poll every">
              <Select value={poll} onChange={setPoll} options={["5", "10", "15", "30", "60"].map((s) => ({ value: s, label: `${s} seconds` }))} searchable={false} />
            </Field>
          </div>
        </div>
      )}
      {type === "replay" && <p className="muted small">After registering, open the asset and upload a CSV recorded from a real machine, then play it back.</p>}
      {type === "manual" && <p className="muted small">Operators record readings from the asset panel. Useful for stations without a controller connection.</p>}
      <Field label="Ideal cycle time (seconds, optional)" hint="Needed for OEE performance; without it OEE stays “—”.">
        <input className="input" type="number" min={0} value={cycle} onChange={(e) => setCycle(e.target.value)} />
      </Field>
      <div className="section-h spread">
        <h3>Limits the agents watch</h3>
        <button type="button" className="link" onClick={() => setLimits([...limits, { signal: "", warn: "", alarm: "", unit: "" }])}>
          + Add limit
        </button>
      </div>
      <table className="t compact">
        <thead>
          <tr>
            <th>Signal</th>
            <th>Warn ≥</th>
            <th>Alarm ≥</th>
            <th>Unit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {limits.map((l, i) => {
            const set = (p: Partial<LimitRow>) => setLimits(limits.map((x, j) => (j === i ? { ...x, ...p } : x)));
            return (
              <tr key={i}>
                <td>
                  <Select size="sm" value={l.signal || null} onChange={(v) => set({ signal: v })} options={SIGNALS.filter((s) => !["execution", "part_count"].includes(s)).map((s) => ({ value: s, label: signalLabel(s) }))} placeholder="Signal" />
                </td>
                <td>
                  <input className="input sm" type="number" value={l.warn} onChange={(e) => set({ warn: e.target.value })} />
                </td>
                <td>
                  <input className="input sm" type="number" value={l.alarm} onChange={(e) => set({ alarm: e.target.value })} />
                </td>
                <td>
                  <input className="input sm" value={l.unit} onChange={(e) => set({ unit: e.target.value })} />
                </td>
                <td>
                  <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setLimits(limits.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="faint small">
        No limits, no alerts: agents only act on thresholds you set. <a href={href("settings")}>Policy</a> decides what they may do on their own.
      </p>
    </Modal>
  );
}
