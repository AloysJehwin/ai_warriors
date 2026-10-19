import { z } from "zod";

export const ROLES = ["operator", "quality_engineer", "maintenance_lead", "plant_manager"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const LEVELS = ["L1", "L2", "L3", "L4"] as const;
export const AutonomyLevel = z.enum(LEVELS);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;
export const levelRank = (l: AutonomyLevel): number => LEVELS.indexOf(l) + 1;

export const SIGNALS = ["vibration_rms", "bearing_temp", "spindle_load", "cycle_time"] as const;
export const SignalName = z.enum(SIGNALS);
export type SignalName = z.infer<typeof SignalName>;
export type Quality = "good" | "uncertain" | "bad";

export interface TelemetrySample {
  assetId: string;
  signal: SignalName;
  value: number;
  unit: string;
  minute: number;
  quality: Quality;
}

// ---- Healer tools: the ONLY actions that can ever execute ----
export const ToolCall = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("adjust_line_speed"), args: z.object({ lineId: z.string(), pctChange: z.number() }) }),
  z.object({ tool: z.literal("hold_gate"), args: z.object({ batchId: z.string(), reason: z.string().min(3) }) }),
  z.object({
    tool: z.literal("reroute_batch"),
    args: z.object({ batchId: z.string(), targetAssetId: z.string(), units: z.number().int().positive() }),
  }),
  z.object({
    tool: z.literal("open_work_order"),
    args: z.object({
      assetId: z.string(),
      priority: z.enum(["low", "medium", "high"]),
      windowMinutes: z.number().int().min(0).max(24 * 60),
    }),
  }),
  z.object({
    tool: z.literal("request_inspection"),
    args: z.object({ assetId: z.string(), sampleRatePct: z.number().min(1).max(100) }),
  }),
]);
export type ToolCall = z.infer<typeof ToolCall>;
export type ToolName = ToolCall["tool"];
export const TOOL_NAMES: ToolName[] = ["adjust_line_speed", "hold_gate", "reroute_batch", "open_work_order", "request_inspection"];

export const Diagnosis = z.object({
  rootCause: z.string().min(10),
  evidence: z.array(z.object({ signal: z.string(), observation: z.string() })).min(1).max(5),
  confidence: z.number().min(0).max(1),
});
export type Diagnosis = z.infer<typeof Diagnosis>;

export const Recommendation = z.object({
  actions: z.array(ToolCall).min(1).max(2),
  reason: z.string().min(10),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.object({ summary: z.string(), tradeoff: z.string() })).max(3),
});
export type Recommendation = z.infer<typeof Recommendation>;

export const ShiftSummary = z.object({
  summary: z.string().min(10),
  citedSeqs: z.array(z.number().int().positive()).min(1),
});
export type ShiftSummary = z.infer<typeof ShiftSummary>;

// ---- API DTOs ----
export interface Anomaly {
  assetId: string;
  signal: SignalName;
  value: number;
  limit: number;
  level: "warn" | "alarm";
  kind: "threshold" | "drift";
  trendPerHour: number;
  minute: number;
}

export interface Forecast {
  assetId: string;
  signal: SignalName;
  failureLimit: number;
  ttfHours: number | null;
  pFailure24h: number;
  confidence: number;
  modelId: string;
}

export type PolicyOutcome = "allow" | "require_approval" | "block";
export interface PolicyResult {
  outcome: PolicyOutcome;
  role?: Role;
  ruleIds: string[];
  explanation: string;
  policyVersion: number;
  policyHash: string;
}

export type IncidentStatus = "open" | "awaiting_approval" | "mitigated" | "closed";
export interface Incident {
  id: string;
  assetId: string;
  lineId: string;
  status: IncidentStatus;
  severity: "warn" | "alarm";
  title: string;
  openedAt: string;
  closedAt: string | null;
  downtimeAvoidedMin: number | null;
}

export type DecisionKind = "detect" | "forecast" | "diagnose" | "recommend" | "guard" | "execute" | "summarize";
export interface Decision {
  id: string;
  incidentId: string;
  agent: string;
  kind: DecisionKind;
  summary: string;
  data: unknown;
  confidence: number | null;
  modelId: string | null;
  ledgerSeq: number;
  ts: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export interface Approval {
  id: string;
  incidentId: string;
  action: ToolCall;
  requiredRole: Role;
  policy: PolicyResult;
  status: ApprovalStatus;
  actor: string | null;
  reason: string | null;
  externalRef: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface LedgerEntryDto {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  incidentId: string | null;
  payload: unknown;
  payloadHash: string;
  prevHash: string;
  entryHash: string;
}

export interface AnchorDto {
  id: number;
  kind: string;
  toSeq: number;
  entryHash: string;
  ref: string;
  url: string | null;
  ts: string;
}

export interface VerifyStep {
  seq: number;
  type: string;
  actor: string;
  ok: boolean;
  reason?: string;
}
export interface VerifyReport {
  incidentId: string;
  ok: boolean;
  chainOk: boolean;
  steps: VerifyStep[];
  anchor: { ok: boolean; kind: string; ref: string; url: string | null; detail: string } | null;
  policy: { ok: boolean; version: number; hash: string; detail: string };
  tamperedSeq: number | null;
}

export interface AssetView {
  id: string;
  name: string;
  lineId: string;
  status: "running" | "idle" | "degraded" | "down" | "maintenance";
  latest: Partial<Record<SignalName, { value: number; quality: Quality }>>;
  ensName: string | null;
  maintenanceAt: number | null;
}
export interface BatchView {
  id: string;
  assetId: string;
  total: number;
  produced: number;
  status: "running" | "held" | "done" | "blocked";
}
export interface PlantView {
  minute: number;
  scenario: string;
  running: boolean;
  line: { id: string; name: string; autonomy: AutonomyLevel; speedPct: number };
  assets: AssetView[];
  batches: BatchView[];
  failures: { assetId: string; minute: number }[];
  mode: { llm: string; anchor: string; payments: string; identity: string };
}

export type StreamEvent =
  | { type: "plant.tick"; plant: PlantView }
  | { type: "incident.updated"; incident: Incident }
  | { type: "decision.recorded"; decision: Decision }
  | { type: "approval.updated"; approval: Approval }
  | { type: "ledger.appended"; entry: LedgerEntryDto }
  | { type: "anchor.recorded"; anchor: AnchorDto }
  | { type: "alert"; level: "info" | "warn"; message: string };
