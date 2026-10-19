import type { Criterion } from "../domain/types.js";

export interface StageMeasurements {
  good: number;
  scrap: number;
  durationMin: number | null;
  activeOee: number | null;
}

export interface CriterionResult {
  label: string;
  target: string;
  actual: string | null;
  ok: boolean | null;
  /** the number compared against the target (after `abs`): what a zero-knowledge proof of the result commits to */
  measured?: { value: number; op: Criterion["op"]; target: number };
}

/**
 * Evaluate success criteria against what was actually measured. A criterion with no measurement
 * returns ok = null: a person must confirm it, it is never assumed to pass.
 */
export function evaluateCriteria(criteria: Criterion[], m: StageMeasurements): CriterionResult[] {
  const total = m.good + m.scrap;
  return criteria.map((c) => {
    const target = `${c.op === ">=" ? "≥" : c.op === "<=" ? "≤" : "="} ${c.abs ? "±" : ""}${c.target}${c.unit ? ` ${c.unit}` : ""}`.trim();
    const label = c.label.toLowerCase();
    let value: number | null = null;
    let shown: string | null = null;
    if (total > 0 && /yield/.test(label)) {
      value = (m.good / total) * 100;
      shown = `${value.toFixed(1)}%`;
    } else if (total > 0 && /^scrap/.test(label)) {
      value = (m.scrap / total) * 100;
      shown = `${value.toFixed(2)}%`;
    } else if (total > 0 && /^defects/.test(label) && c.unit === "ppm") {
      value = (m.scrap / total) * 1e6;
      shown = `${Math.round(value)} ppm`;
    } else if (m.good > 0 && m.durationMin !== null && /cycle time/.test(label)) {
      value = c.unit === "s" ? (m.durationMin * 60) / m.good : m.durationMin / m.good;
      shown = `${value.toFixed(c.unit === "s" ? 0 : 2)} ${c.unit}`;
    } else if (m.activeOee !== null && /^oee/.test(label)) {
      value = m.activeOee * 100;
      shown = `${value.toFixed(0)}%`;
    }
    if (value === null) return { label: c.label, target, actual: null, ok: null };
    const v = c.abs ? Math.abs(value) : value;
    const ok = c.op === ">=" ? v >= c.target : c.op === "<=" ? v <= c.target : v === c.target;
    return { label: c.label, target, actual: shown, ok, measured: { value: v, op: c.op, target: c.target } };
  });
}
