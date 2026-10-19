import type { AnchorDto, Approval, AutonomyLevel, Decision, Incident, LedgerEntryDto, PlantView, Role, VerifyReport } from "./types";

export interface Actor {
  name: string;
  role: Role;
}

/** Empty when the console is served by the API (one container); set VITE_API_BASE when hosting the console separately (e.g. Vercel). */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

// ---- Optional shared passcode for writes (DEMO_PASSCODE on the server) ----
export function getPasscode(): string {
  try {
    return localStorage.getItem("ordo.passcode") ?? "";
  } catch {
    return "";
  }
}
export function setPasscode(v: string) {
  try {
    localStorage.setItem("ordo.passcode", v);
  } catch {
    /* ignore */
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (method !== "GET" && getPasscode()) headers["x-ordo-passcode"] = getPasscode();
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("This deployment needs a passcode for changes. Enter it on the System page.");
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export interface RailStatus {
  rail: string;
  mode: string;
  live: boolean;
}
export interface Status {
  rails: RailStatus[];
  warnings: string[];
  passcodeRequired: boolean;
  policy: { id: string; version: number; hash: string };
  build: { env: string; commit: string | null } | null;
}
export interface LiveDelta {
  plant: PlantView;
  entries: LedgerEntryDto[];
  decisions: Decision[];
  incidents: Incident[];
  approvals: Approval[];
  anchors: AnchorDto[];
}

export const api = {
  plant: () => req<PlantView>("GET", "/v1/plant"),
  live: (since: number) => req<LiveDelta>("GET", `/v1/live?since=${since}`),
  status: () => req<Status>("GET", "/v1/status"),
  anchorNow: () => req<AnchorDto | null>("POST", "/v1/anchors"),
  start: (scenario: string) => req<PlantView>("POST", `/v1/sim/scenarios/${scenario}/start`),
  pause: () => req<PlantView>("POST", "/v1/sim/pause"),
  resume: () => req<PlantView>("POST", "/v1/sim/resume"),
  step: (minutes: number) => req<PlantView>("POST", `/v1/sim/step?minutes=${minutes}`),
  autonomy: (level: AutonomyLevel, actor: Actor) => req<PlantView>("PATCH", "/v1/line/autonomy", { level, actor }),
  incidents: () => req<Incident[]>("GET", "/v1/incidents"),
  incident: (id: string) => req<{ incident: Incident; decisions: Decision[]; approvals: Approval[]; entries: LedgerEntryDto[] }>("GET", `/v1/incidents/${id}`),
  decisions: (limit = 40) => req<Decision[]>("GET", `/v1/decisions?limit=${limit}`),
  approvals: (status?: string) => req<Approval[]>("GET", `/v1/approvals${status ? `?status=${status}` : ""}`),
  approve: (id: string, actor: Actor, reason?: string) => req<Approval>("POST", `/v1/approvals/${id}/approve`, { actor, reason }),
  reject: (id: string, actor: Actor, reason: string) => req<Approval>("POST", `/v1/approvals/${id}/reject`, { actor, reason }),
  ledger: (limit = 150) => req<LedgerEntryDto[]>("GET", `/v1/ledger?limit=${limit}`),
  anchors: () => req<AnchorDto[]>("GET", "/v1/anchors"),
  verify: (id: string, tamper?: number | null) => req<VerifyReport>("GET", `/v1/verify/incidents/${id}${tamper ? `?tamper=${tamper}` : ""}`),
  shiftSummary: () => req<{ summary: string; citedSeqs: number[]; seq: number }>("POST", "/v1/summaries/shift"),
  policy: () => req<{ policy: unknown; hash: string }>("GET", "/v1/policy"),
};

// ---- "Acting as" (no SSO in the MVP; every action records this identity) ----
const RANK: Record<Role, number> = { operator: 1, quality_engineer: 2, maintenance_lead: 3, plant_manager: 4 };
export const canApprove = (actor: Role, required: Role) => actor === required || RANK[actor] > RANK[required];

export const ROLE_LABEL: Record<Role, string> = {
  operator: "Operator",
  quality_engineer: "Quality engineer",
  maintenance_lead: "Maintenance lead",
  plant_manager: "Plant manager",
};
const DEFAULT_NAMES: Record<Role, string> = { operator: "A. Shah", quality_engineer: "L. Chen", maintenance_lead: "R. Iyer", plant_manager: "M. Okafor" };
export function loadActor(): Actor {
  try {
    const raw = localStorage.getItem("ordo.actor");
    if (raw) return JSON.parse(raw) as Actor;
  } catch {
    /* storage unavailable */
  }
  return { name: DEFAULT_NAMES.operator, role: "operator" };
}
export function saveActor(role: Role): Actor {
  const a = { name: DEFAULT_NAMES[role], role };
  try {
    localStorage.setItem("ordo.actor", JSON.stringify(a));
  } catch {
    /* ignore */
  }
  return a;
}
