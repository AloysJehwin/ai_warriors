import type { LlmProvider, LlmResult, LlmTask } from "../adapters/llm.js";
import { LIMITS } from "../domain/limits.js";
import { Diagnosis, Recommendation, ShiftSummary, type Anomaly, type BatchView, type Forecast, type SignalName, type TelemetrySample, type ToolCall } from "../domain/types.js";
import { groundingCheck } from "./grounding.js";

// ---------------- Context builders ----------------
export interface SignalStats {
  last: number;
  min: number;
  max: number;
  mean: number;
  n: number;
}
export function signalStats(samples: TelemetrySample[], assetId: string, minutes = 30): Partial<Record<SignalName, SignalStats>> {
  const latest = samples.at(-1)?.minute ?? 0;
  const out: Partial<Record<SignalName, SignalStats>> = {};
  for (const s of samples) {
    if (s.assetId !== assetId || s.quality !== "good" || s.minute <= latest - minutes) continue;
    const st = out[s.signal] ?? { last: s.value, min: s.value, max: s.value, mean: 0, n: 0 };
    st.last = s.value;
    st.min = Math.min(st.min, s.value);
    st.max = Math.max(st.max, s.value);
    st.mean += s.value;
    st.n += 1;
    out[s.signal] = st;
  }
  for (const st of Object.values(out)) st.mean = Math.round((st.mean / st.n) * 100) / 100;
  return out;
}

export interface DiagnosisInput {
  asset: { id: string; status: string };
  anomaly: Anomaly;
  forecast: Forecast;
  last30min: Partial<Record<SignalName, SignalStats>>;
  limits: typeof LIMITS;
}

export interface RecommendInput {
  lineId: string;
  asset: { id: string; status: string };
  anomaly: Anomaly;
  forecast: Forecast;
  diagnosis: { rootCause: string; confidence: number };
  batchOnAsset: { id: string; remainingUnits: number } | null;
  availableAssets: { id: string; status: string; vibration_rms: number | null }[];
  lineSpeedPct: number;
  tools: string;
}

// ---------------- Prompts (versioned with the code; their hash is recorded per decision) ----------------
const SYSTEM = `You are an agent inside Ordo, a manufacturing orchestration system. You advise; you never act directly.
A deterministic policy guard checks everything you propose. Use only numbers that appear in the INPUT.
Be concise, specific and technical. Never invent sensor readings, units, assets or batches.`;

export const DIAGNOSE_PROMPT = `Task: explain the most likely root cause of the anomaly on the asset in plain language for a plant engineer.
Cite the signal values from INPUT (with units). Distinguish mechanical wear, thermal/cooling faults, overload and sensor faults.
Return JSON: { rootCause: string (2-3 sentences), evidence: [{ signal, observation }] (1-5 items), confidence: 0..1 }.`;

export const TOOLS_DOC = `Allowed tools (choose 1 or 2 actions; anything else is blocked):
- reroute_batch { batchId, targetAssetId, units }      move a batch's remaining units to an idle healthy asset
- open_work_order { assetId, priority: low|medium|high, windowMinutes }  schedule maintenance (30 min) after windowMinutes
- adjust_line_speed { lineId, pctChange }               slow down (-20..0) or speed up (0..10) the whole line
- hold_gate { batchId, reason }                          stop a batch at its quality gate
- request_inspection { assetId, sampleRatePct }          raise inspection sampling`;

export const RECOMMEND_PROMPT = `Task: recommend the safest effective intervention for this incident.
Prefer actions that keep production running and prevent the predicted failure before it happens.
Rerouted units must equal the batch's remainingUnits. Only target assets listed as idle in availableAssets.
Give up to 3 alternatives you rejected, each with its trade-off.
Return JSON: { actions: [ { tool, args } ] (1-2), reason: string, confidence: 0..1, alternatives: [{ summary, tradeoff }] }.`;

export const SUMMARY_PROMPT = `Task: write a short shift-handoff summary of the ledger entries in INPUT for the next shift and for QA.
Mention what happened, what was decided, who approved, and what is still open. Cite ledger sequence numbers.
Return JSON: { summary: string (max 120 words), citedSeqs: number[] }.`;

// ---------------- Offline (deterministic, grounded) outputs ----------------
const r2 = (n: number) => Math.round(n * 100) / 100;

export function offlineDiagnosis(i: DiagnosisInput): Diagnosis {
  const a = i.anomaly;
  const vib = i.last30min.vibration_rms;
  const temp = i.last30min.bearing_temp;
  const load = i.last30min.spindle_load;
  const conf = r2(Math.min(0.9, Math.max(0.55, i.forecast.confidence)));
  if (a.signal === "vibration_rms") {
    return {
      rootCause: `Progressive spindle bearing wear on ${i.asset.id}. Vibration RMS reached ${a.value} mm/s against the ${a.limit} mm/s ${a.level} limit and is rising ${a.trendPerHour} mm/s per hour, while bearing temperature climbed to ${temp?.max ?? "n/a"} °C. A steady, correlated rise in both signals points to mechanical degradation rather than a sensor fault.`,
      evidence: [
        { signal: "vibration_rms", observation: `${vib?.min ?? a.value} → ${a.value} mm/s over the last 30 min` },
        { signal: "bearing_temp", observation: `max ${temp?.max ?? "n/a"} °C, mean ${temp?.mean ?? "n/a"} °C` },
      ],
      confidence: conf,
    };
  }
  if (a.signal === "bearing_temp") {
    return {
      rootCause: `Thermal excursion on ${i.asset.id}: bearing temperature reached ${a.value} °C against the ${a.limit} °C ${a.level} limit, a step change rather than a slow climb, while vibration stayed near ${vib?.mean ?? "n/a"} mm/s. This pattern points to a coolant or lubrication supply fault, not bearing wear.`,
      evidence: [
        { signal: "bearing_temp", observation: `${temp?.min ?? "n/a"} → ${a.value} °C` },
        { signal: "vibration_rms", observation: `mean ${vib?.mean ?? "n/a"} mm/s, no matching rise` },
      ],
      confidence: 0.8,
    };
  }
  return {
    rootCause: `Spindle overload on ${i.asset.id}: load reached ${a.value}% against the ${a.limit}% ${a.level} limit. Likely tool wear or an aggressive feed rate for the current program.`,
    evidence: [{ signal: "spindle_load", observation: `max ${load?.max ?? a.value}%` }],
    confidence: 0.7,
  };
}

export function offlineRecommendation(i: RecommendInput): Recommendation {
  const idle = i.availableAssets.find((x) => x.status === "idle");
  const actions: ToolCall[] = [];
  const alternatives: Recommendation["alternatives"] = [];
  const pct = Math.round(i.forecast.pFailure24h * 100);
  if (i.anomaly.signal === "bearing_temp") {
    if (i.batchOnAsset) actions.push({ tool: "hold_gate", args: { batchId: i.batchOnAsset.id, reason: `Bearing temperature ${i.anomaly.value} °C above limit` } });
    actions.push({ tool: "open_work_order", args: { assetId: i.asset.id, priority: "high", windowMinutes: 0 } });
    alternatives.push({ summary: "Slow the line by 10%", tradeoff: "Reduces heat slowly but keeps a hot spindle cutting parts" });
    return { actions, reason: `Temperature is already past the alarm limit on ${i.asset.id}; stop parts at the gate and inspect the cooling supply now.`, confidence: 0.82, alternatives };
  }
  const ttfMin = i.forecast.ttfHours === null ? null : Math.round(i.forecast.ttfHours * 60);
  const window = ttfMin === null ? 60 : Math.max(5, Math.min(30, Math.floor(ttfMin / 3)));
  if (i.batchOnAsset && idle) {
    actions.push({ tool: "reroute_batch", args: { batchId: i.batchOnAsset.id, targetAssetId: idle.id, units: i.batchOnAsset.remainingUnits } });
    alternatives.push({ summary: `Finish ${i.batchOnAsset.id} on ${i.asset.id}, then repair`, tradeoff: `${pct}% risk of an unplanned stop before the batch completes` });
  }
  actions.push({ tool: "open_work_order", args: { assetId: i.asset.id, priority: "high", windowMinutes: window } });
  alternatives.push({ summary: `Stop ${i.asset.id} immediately`, tradeoff: "Safest for the bearing but loses production until the batch is moved by hand" });
  const moved = actions[0]?.tool === "reroute_batch" ? `Move the remaining ${i.batchOnAsset!.remainingUnits} units of ${i.batchOnAsset!.id} to idle ${idle!.id} and` : "";
  return {
    actions,
    reason: `${moved} schedule bearing maintenance on ${i.asset.id} within ${window} minutes; projected time to the ${i.forecast.failureLimit} mm/s limit is ${ttfMin ?? "unknown"} minutes with ${pct}% failure probability.`.trim(),
    confidence: r2(Math.min(0.92, Math.max(0.6, i.forecast.confidence))),
    alternatives,
  };
}

export interface SummaryInput {
  entries: { seq: number; type: string; actor: string; incidentId: string | null; brief: string }[];
}
export function offlineSummary(i: SummaryInput): ShiftSummary {
  const pick = i.entries.filter((e) => /incident\.|action\.|approval\.|asset\.failed|autonomy/.test(e.type)).slice(-8);
  const used = pick.length ? pick : i.entries.slice(-3);
  const lines = used.map((e) => `#${e.seq} ${e.brief}`);
  const open = i.entries.some((e) => e.type === "approval.requested") && !i.entries.some((e) => e.type === "approval.granted" || e.type === "approval.rejected");
  return {
    summary: `Shift handoff. ${lines.join(". ")}.${open ? " Approvals are still pending." : " No approvals pending."}`.slice(0, 900),
    citedSeqs: used.map((e) => e.seq),
  };
}

// ---------------- Agents ----------------
export class Agents {
  constructor(private llm: LlmProvider) {}

  diagnose(input: DiagnosisInput): Promise<LlmResult<Diagnosis>> {
    const task: LlmTask<Diagnosis> = { name: "diagnose", system: SYSTEM, prompt: DIAGNOSE_PROMPT, input, schema: Diagnosis, offline: offlineDiagnosis as never };
    return this.llm.generate(task);
  }

  async recommend(input: RecommendInput): Promise<LlmResult<Recommendation> & { grounding: { ok: boolean; unknownNumbers: number[] } }> {
    const task: LlmTask<Recommendation> = { name: "recommend", system: SYSTEM, prompt: RECOMMEND_PROMPT, input, schema: Recommendation, offline: offlineRecommendation as never };
    const r = await this.llm.generate(task);
    const grounding = groundingCheck(r.value.reason, { input, actions: r.value.actions });
    // Ungrounded numbers cap confidence below the guard threshold so a person reviews it.
    const value = grounding.ok ? r.value : { ...r.value, confidence: Math.min(r.value.confidence, 0.6) };
    return { ...r, value, grounding };
  }

  summarize(input: SummaryInput): Promise<LlmResult<ShiftSummary>> {
    const task: LlmTask<ShiftSummary> = { name: "summarize", system: SYSTEM, prompt: SUMMARY_PROMPT, input, schema: ShiftSummary, offline: offlineSummary as never };
    return this.llm.generate(task);
  }
}

export const remainingUnits = (b: BatchView) => Math.max(0, Math.round(b.total - b.produced));
