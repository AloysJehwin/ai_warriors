import { LIMITS } from "./limits.js";
import type { Anomaly, SignalName, TelemetrySample } from "./types.js";

const MIN_DRIFT_SAMPLES = 30;
const DRIFT_Z = 6;

function slopePerMinute(xs: number[], ys: number[]): { slope: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}
export { slopePerMinute };

/**
 * Line agent. Looks at one asset's recent samples for one signal (oldest first).
 * Only good-quality samples count; a sensor reporting "bad" never triggers an action.
 */
export function detect(samples: TelemetrySample[], signal: SignalName): Anomaly | null {
  const limit = LIMITS[signal];
  if (!limit) return null;
  const good = samples.filter((s) => s.signal === signal && s.quality === "good");
  const last = good.at(-1);
  if (!last) return null;
  const window = good.slice(-20);
  const { slope } = slopePerMinute(
    window.map((s) => s.minute),
    window.map((s) => s.value),
  );
  const trendPerHour = Math.round(slope * 60 * 100) / 100;

  if (last.value >= limit.alarm)
    return { assetId: last.assetId, signal, value: last.value, limit: limit.alarm, level: "alarm", kind: "threshold", trendPerHour, minute: last.minute };
  if (last.value >= limit.warn)
    return { assetId: last.assetId, signal, value: last.value, limit: limit.warn, level: "warn", kind: "threshold", trendPerHour, minute: last.minute };

  // Drift: the last 10 good samples sit far above the earliest baseline window.
  if (good.length >= MIN_DRIFT_SAMPLES) {
    const base = good.slice(0, 15).map((s) => s.value);
    const recent = good.slice(-10).map((s) => s.value);
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const mb = mean(base);
    const sd = Math.sqrt(base.reduce((a, b) => a + (b - mb) ** 2, 0) / base.length) || 1e-6;
    const z = (mean(recent) - mb) / sd;
    if (z >= DRIFT_Z && slope > 0)
      return { assetId: last.assetId, signal, value: last.value, limit: limit.warn, level: "warn", kind: "drift", trendPerHour, minute: last.minute };
  }
  return null;
}

export function detectAll(samples: TelemetrySample[]): Anomaly | null {
  const found = (["vibration_rms", "bearing_temp", "spindle_load"] as SignalName[])
    .map((s) => detect(samples, s))
    .filter((a): a is Anomaly => a !== null);
  // Alarms first, then threshold before drift.
  found.sort((a, b) => (a.level === b.level ? (a.kind === "threshold" ? -1 : 1) : a.level === "alarm" ? -1 : 1));
  return found[0] ?? null;
}
