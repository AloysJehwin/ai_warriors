import { gaussian, mulberry32 } from "./rng.js";
import { UNITS } from "./limits.js";
import type { AssetView, BatchView, SignalName, TelemetrySample, ToolCall } from "./types.js";

export const SCENARIOS = ["normal", "bearing_wear", "overheat", "sensor_fault"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Wear at which the bearing fails (unplanned stop). */
export const FAILURE_WEAR = 0.85;
export const MAINTENANCE_DURATION_MIN = 30;
const FULL_LOAD = 0.85;

interface SimAsset {
  id: string;
  name: string;
  lineId: string;
  status: AssetView["status"];
  wear: number;
  wearRate: number; // wear per minute at full load
  tempOffset: number;
  sensorFault: boolean;
  maintenanceAt: number | null;
  maintenanceUntil: number | null;
  inspectionPct: number;
}

export interface ActionEffect {
  ok: boolean;
  summary: string;
}

export class Plant {
  readonly lineId = "LINE-02";
  readonly lineName = "Line 02 · Machining";
  minute = 0;
  speedPct = 0;
  assets: SimAsset[];
  batches: BatchView[];
  failures: { assetId: string; minute: number }[] = [];
  private rand: () => number;
  private latest = new Map<string, Partial<Record<SignalName, { value: number; quality: TelemetrySample["quality"] }>>>();

  constructor(
    readonly seed: number,
    readonly scenario: Scenario,
  ) {
    this.rand = mulberry32(seed);
    const mk = (id: string, name: string, wear: number, wearRate: number): SimAsset => ({
      id,
      name,
      lineId: this.lineId,
      status: "running",
      wear,
      wearRate,
      tempOffset: 0,
      sensorFault: false,
      maintenanceAt: null,
      maintenanceUntil: null,
      inspectionPct: 5,
    });
    this.assets = [mk("CNC-04", "CNC-04 · 5-axis mill", 0.12, 0.0002), mk("CNC-05", "CNC-05 · 5-axis mill", 0.14, 0.0002), mk("CNC-07", "CNC-07 · 5-axis mill", 0.06, 0.0002)];
    this.batches = [
      { id: "B-2417", assetId: "CNC-05", total: 180, produced: 100, status: "running" },
      { id: "B-2418", assetId: "CNC-04", total: 120, produced: 30, status: "running" },
    ];
    const cnc05 = this.asset("CNC-05");
    if (scenario === "bearing_wear") {
      cnc05.wear = 0.28;
      cnc05.wearRate = 0.008;
    }
    if (scenario === "overheat") cnc05.wearRate = 0.001;
  }

  asset(id: string): SimAsset {
    const a = this.assets.find((x) => x.id === id);
    if (!a) throw new Error(`unknown asset ${id}`);
    return a;
  }

  private batchOn(assetId: string): BatchView | undefined {
    return this.batches.find((b) => b.assetId === assetId && (b.status === "running" || b.status === "held"));
  }

  private load(a: SimAsset): number {
    if (a.status === "down" || a.status === "maintenance") return 0;
    const b = this.batchOn(a.id);
    const speed = 1 + this.speedPct / 100;
    return b && b.status === "running" ? FULL_LOAD * speed : 0.15;
  }

  /** Advance one plant minute and return the telemetry emitted. */
  tick(): TelemetrySample[] {
    this.minute += 1;
    const m = this.minute;
    if (this.scenario === "overheat" && m === 5) this.asset("CNC-05").tempOffset = 28;
    if (this.scenario === "sensor_fault" && m === 3) this.asset("CNC-04").sensorFault = true;

    const out: TelemetrySample[] = [];
    for (const a of this.assets) {
      // maintenance lifecycle
      if (a.maintenanceAt !== null && m >= a.maintenanceAt && a.status !== "maintenance") {
        a.status = "maintenance";
        a.maintenanceUntil = m + MAINTENANCE_DURATION_MIN;
      }
      if (a.status === "maintenance" && a.maintenanceUntil !== null && m >= a.maintenanceUntil) {
        a.wear = 0.05;
        a.wearRate = 0.0002;
        a.tempOffset = 0;
        a.maintenanceAt = null;
        a.maintenanceUntil = null;
        a.status = "running";
      }

      const load = this.load(a);
      if (a.status !== "down" && a.status !== "maintenance") {
        a.wear = Math.min(1, a.wear + a.wearRate * (load / FULL_LOAD));
        if (a.wear >= FAILURE_WEAR) {
          a.status = "down";
          this.failures.push({ assetId: a.id, minute: m });
        } else {
          a.status = !this.batchOn(a.id) ? "idle" : a.wear >= 0.33 ? "degraded" : "running";
        }
      }

      // production
      const b = this.batchOn(a.id);
      if (b) {
        if (a.status === "down" || a.status === "maintenance") b.status = b.status === "held" ? "held" : "blocked";
        else if (b.status === "blocked") b.status = "running";
        if (b.status === "running") {
          b.produced = Math.min(b.total, b.produced + (1 + this.speedPct / 100));
          if (b.produced >= b.total) b.status = "done";
        }
      }

      const active = a.status !== "down" && a.status !== "maintenance";
      const n = (sd: number) => gaussian(this.rand, sd);
      const signals: Record<SignalName, number> = {
        vibration_rms: active ? 2.2 + 7 * a.wear * (0.6 + 0.4 * load) + n(0.06) : 0.3 + Math.abs(n(0.05)),
        bearing_temp: active ? 58 + 30 * a.wear + 8 * load + a.tempOffset + n(0.25) : 35 + n(0.3),
        spindle_load: active ? 100 * load + n(1) : 0,
        cycle_time: active && load > 0.2 ? (1800 / (1 + this.speedPct / 100)) * (1 + 0.3 * a.wear) + n(10) : 0,
      };
      const latest: Partial<Record<SignalName, { value: number; quality: TelemetrySample["quality"] }>> = {};
      for (const s of Object.keys(signals) as SignalName[]) {
        let value = Math.round(signals[s] * 100) / 100;
        // A stopped machine's sensors read, but not under load: not usable for condition monitoring.
        let quality: TelemetrySample["quality"] = active ? "good" : "uncertain";
        if (a.sensorFault && s === "vibration_rms") {
          value = 15 + Math.round(n(2) * 100) / 100;
          quality = "bad";
        }
        out.push({ assetId: a.id, signal: s, value, unit: UNITS[s], minute: m, quality });
        latest[s] = { value, quality };
      }
      this.latest.set(a.id, latest);
    }
    return out;
  }

  /** Apply an executed Healer action to the simulated line. */
  apply(action: ToolCall): ActionEffect {
    switch (action.tool) {
      case "adjust_line_speed": {
        this.speedPct = Math.max(-50, Math.min(20, this.speedPct + action.args.pctChange));
        return { ok: true, summary: `Line speed now ${this.speedPct >= 0 ? "+" : ""}${this.speedPct}%` };
      }
      case "hold_gate": {
        const b = this.batches.find((x) => x.id === action.args.batchId);
        if (!b) return { ok: false, summary: `Batch ${action.args.batchId} not found` };
        b.status = "held";
        return { ok: true, summary: `Batch ${b.id} held: ${action.args.reason}` };
      }
      case "reroute_batch": {
        const b = this.batches.find((x) => x.id === action.args.batchId);
        if (!b) return { ok: false, summary: `Batch ${action.args.batchId} not found` };
        const target = this.asset(action.args.targetAssetId);
        if (target.status === "down" || target.status === "maintenance")
          return { ok: false, summary: `${target.id} is not available` };
        if (this.batchOn(target.id)) return { ok: false, summary: `${target.id} is busy` };
        const from = b.assetId;
        b.assetId = target.id;
        if (b.status === "blocked") b.status = "running";
        return { ok: true, summary: `Moved ${Math.round(b.total - b.produced)} remaining units of ${b.id} from ${from} to ${target.id}` };
      }
      case "open_work_order": {
        const a = this.asset(action.args.assetId);
        a.maintenanceAt = this.minute + action.args.windowMinutes;
        return { ok: true, summary: `Maintenance on ${a.id} scheduled at plant minute ${a.maintenanceAt} (${MAINTENANCE_DURATION_MIN} min)` };
      }
      case "request_inspection": {
        const a = this.asset(action.args.assetId);
        a.inspectionPct = action.args.sampleRatePct;
        return { ok: true, summary: `Inspection sampling on ${a.id} raised to ${a.inspectionPct}%` };
      }
    }
  }

  assetsView(ensNames: Record<string, string | null> = {}): AssetView[] {
    return this.assets.map((a) => ({
      id: a.id,
      name: a.name,
      lineId: a.lineId,
      status: a.status,
      latest: this.latest.get(a.id) ?? {},
      ensName: ensNames[a.id] ?? null,
      maintenanceAt: a.maintenanceAt,
    }));
  }

  batchesView(): BatchView[] {
    return this.batches.map((b) => ({ ...b, produced: Math.round(b.produced) }));
  }
}
