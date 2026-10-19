import { useSyncExternalStore } from "react";
import { api, type Status } from "./api";
import type { AnchorDto, Approval, Decision, Incident, LedgerEntryDto, PlantView, SignalName } from "./types";

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
  status: Status | null;
}

const HISTORY = 90;
const POLL_MS = Number(import.meta.env.VITE_POLL_MS ?? 1000);
let state: LiveState = { connected: false, plant: null, history: {}, incidents: {}, approvals: {}, decisions: [], ledger: [], anchors: [], alerts: [], status: null };
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

function nextHistory(p: PlantView): LiveState["history"] {
  const history = { ...state.history };
  const last = state.plant?.minute ?? -1;
  if (p.minute < last || p.scenario !== state.plant?.scenario) for (const k of Object.keys(history)) delete history[k];
  if (p.minute !== last)
    for (const a of p.assets) {
      const h = { ...(history[a.id] ?? {}) };
      for (const [sig, v] of Object.entries(a.latest)) {
        if (!v || v.quality !== "good") continue;
        h[sig as SignalName] = [...(h[sig as SignalName] ?? []), v.value].slice(-HISTORY);
      }
      history[a.id] = h;
    }
  return history;
}

let since = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

async function poll() {
  try {
    const d = await api.live(since);
    const seen = new Set(state.decisions.map((x) => x.id));
    const ledger = [...d.entries, ...state.ledger.filter((e) => !d.entries.some((n) => n.seq === e.seq))].sort((a, b) => b.seq - a.seq).slice(0, 300);
    // A reset elsewhere (new run) can make our cursor run ahead of an empty ledger; the server never rewinds seq, so this is safe.
    since = Math.max(since, ...d.entries.map((e) => e.seq));
    set({
      connected: true,
      history: nextHistory(d.plant),
      plant: d.plant,
      ledger,
      decisions: [...d.decisions.filter((x) => !seen.has(x.id)), ...state.decisions].sort((a, b) => b.ledgerSeq - a.ledgerSeq).slice(0, 80),
      incidents: Object.fromEntries(d.incidents.map((i) => [i.id, i])),
      approvals: Object.fromEntries(d.approvals.map((a) => [a.id, a])),
      anchors: d.anchors,
    });
    failures = 0;
  } catch (e) {
    failures += 1;
    if (state.connected) set({ connected: false });
    if (failures === 3) pushAlert(`Lost contact with the API: ${e instanceof Error ? e.message : e}`);
  } finally {
    timer = setTimeout(poll, failures ? Math.min(10_000, POLL_MS * 2 ** failures) : POLL_MS);
  }
}

/** Poll now (after a user action) instead of waiting for the next tick. */
export function refreshNow() {
  if (timer) clearTimeout(timer);
  void poll();
}

export function connect() {
  if (timer) return;
  api.status().then((status) => set({ status }), () => undefined);
  void poll();
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
