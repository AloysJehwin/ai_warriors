import type { SignalName } from "./types.js";

/** Signal limits. Vibration bands follow ISO 10816-3 style velocity RMS zones (mm/s). */
export const LIMITS: Record<SignalName, { unit: string; warn: number; alarm: number } | null> = {
  vibration_rms: { unit: "mm/s", warn: 4.5, alarm: 7.1 },
  bearing_temp: { unit: "°C", warn: 80, alarm: 90 },
  spindle_load: { unit: "%", warn: 95, alarm: 105 },
  cycle_time: null,
};

export const UNITS: Record<SignalName, string> = {
  vibration_rms: "mm/s",
  bearing_temp: "°C",
  spindle_load: "%",
  cycle_time: "ms",
};
