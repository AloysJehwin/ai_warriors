import { useSyncExternalStore } from "react";
import { API_BASE, api } from "./api";
import type { AnchorDto, Approval, Decision, Incident, LedgerEntryDto, PlantView, SignalName, StreamEvent } from "./types";

export interface LiveState {
  connected: boolean;
  plant: PlantView | null;
  history: Record<string, Partial<Record<SignalName, number[]>>>;
  incidents: Record<string, Incident>;
  approvals: Record<string, Approval>;
  decisions: Decision[];
  ledger: LedgerEntryDto[];
  anchors: AnchorDto[];
  alerts: { id: number; message: string }[];
}

const HISTORY = 90;
let state: LiveState = { connected: false, plant: null, history: {}, incidents: {}, approvals: {}, decisions: [], ledger: [], anchors: [], alerts: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<LiveState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

let alertId = 0;
export function pushAlert(message: string) {
  const id = ++alertId;
  set({ alerts: [...state.alerts, { id, message }].slice(-4) });
  setTimeout(() => set({ alerts: state.alerts.filter((a) => a.id !== id) }), 6000);
}

function onPlant(p: PlantView) {
  const history = { ...state.history };
  const last = state.plant?.minute ?? -1;
  if (p.minute < last) for (const k of Object.keys(history)) delete history[k];
  if (p.minute !== last)
    for (const a of p.assets) {
      const h = { ...(history[a.id] ?? {}) };
      for (const [sig, v] of Object.entries(a.latest)) {
        if (!v || v.quality === "bad") continue;
        h[sig as SignalName] = [...(h[sig as SignalName] ?? []), v.value].slice(-HISTORY);
      }
      history[a.id] = h;
    }
  set({ plant: p, history });
}

function apply(e: StreamEvent) {
  switch (e.type) {
    case "plant.tick":
      return onPlant(e.plant);
    case "incident.updated":
      return set({ incidents: { ...state.incidents, [e.incident.id]: e.incident } });
    case "approval.updated":
      return set({ approvals: { ...state.approvals, [e.approval.id]: e.approval } });
    case "decision.recorded":
      return set({ decisions: [e.decision, ...state.decisions].slice(0, 80) });
    case "ledger.appended":
      return set({ ledger: [e.entry, ...state.ledger.filter((x) => x.seq !== e.entry.seq)].slice(0, 300) });
    case "anchor.recorded":
      return set({ anchors: [e.anchor, ...state.anchors].slice(0, 50) });
    case "alert":
      return pushAlert(e.message);
  }
}

async function refresh() {
  const [incidents, approvals, ledger, anchors, decisions] = await Promise.all([api.incidents(), api.approvals(), api.ledger(), api.anchors(), api.decisions()]);
  set({
    incidents: Object.fromEntries(incidents.map((i) => [i.id, i])),
    approvals: Object.fromEntries(approvals.map((a) => [a.id, a])),
    ledger,
    anchors,
    decisions,
  });
}

let es: EventSource | null = null;
export function connect() {
  if (es) return;
  es = new EventSource(`${API_BASE}/v1/stream`);
  es.onopen = () => {
    set({ connected: true });
    refresh().catch((e) => pushAlert(String(e)));
  };
  es.onerror = () => set({ connected: false });
  const handler = (m: MessageEvent<string>) => {
    try {
      apply(JSON.parse(m.data) as StreamEvent);
    } catch {
      /* ignore malformed */
    }
  };
  for (const t of ["plant.tick", "incident.updated", "approval.updated", "decision.recorded", "ledger.appended", "anchor.recorded", "alert"]) es.addEventListener(t, handler as EventListener);
}

export function useLive(): LiveState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
export const getLive = () => state;
