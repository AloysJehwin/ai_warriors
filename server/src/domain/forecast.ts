import { LIMITS } from "./limits.js";
import { slopePerMinute } from "./detector.js";
import type { Forecast, SignalName, TelemetrySample } from "./types.js";

export const FORECAST_MODEL_ID = "trend-logit-v1";
/** Logistic mapping from time-to-failure (hours) to P(failure within 24 h). */
export const LOGIT = { midpointHours: 6, scaleHours: 2 };

/**
 * Maintenance agent. Fits a linear trend to the last 30 good samples and projects when
 * the signal crosses its alarm limit. Plant time: 1 sample = 1 minute.
 */
export function forecast(samples: TelemetrySample[], assetId: string, signal: SignalName): Forecast {
  const limit = LIMITS[signal];
  const failureLimit = limit?.alarm ?? Number.POSITIVE_INFINITY;
  const good = samples.filter((s) => s.assetId === assetId && s.signal === signal && s.quality === "good").slice(-30);
  const last = good.at(-1);
  const { slope, r2 } = slopePerMinute(
    good.map((s) => s.minute),
    good.map((s) => s.value),
  );

  let ttfHours: number | null;
  if (!last) ttfHours = null;
  else if (last.value >= failureLimit) ttfHours = 0;
  else if (slope > 1e-6) ttfHours = (failureLimit - last.value) / slope / 60;
  else ttfHours = null; // not trending toward the limit

  const p = ttfHours === null ? 0.02 : 1 / (1 + Math.exp((ttfHours - LOGIT.midpointHours) / LOGIT.scaleHours));
  const pFailure24h = Math.round(Math.min(0.98, Math.max(0.02, p)) * 100) / 100;
  const confidence = Math.round((slope > 1e-6 ? Math.min(0.95, Math.max(0.3, r2)) : 0.5) * 100) / 100;
  return {
    assetId,
    signal,
    failureLimit,
    ttfHours: ttfHours === null ? null : Math.round(ttfHours * 100) / 100,
    pFailure24h,
    confidence,
    modelId: FORECAST_MODEL_ID,
  };
}
