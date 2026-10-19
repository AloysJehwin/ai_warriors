import type { ReactNode } from "react";
import type { AssetView, IncidentStatus } from "./ui-types";

export function Sparkline({ values, warn, alarm, width = 160, height = 30 }: { values: number[]; warn?: number; alarm?: number; width?: number; height?: number }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const lo = Math.min(...values, warn ?? Number.POSITIVE_INFINITY) * 0.98;
  const hi = Math.max(...values, alarm ?? warn ?? Number.NEGATIVE_INFINITY) * 1.02;
  const range = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - ((v - lo) / range) * height;
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values.at(-1) ?? 0;
  const color = alarm !== undefined && last >= alarm ? "var(--bad)" : warn !== undefined && last >= warn ? "var(--warn)" : "var(--accent)";
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="trend">
      {warn !== undefined && warn <= hi && <line x1="0" x2={width} y1={y(warn)} y2={y(warn)} stroke="var(--warn)" strokeDasharray="3 3" strokeWidth="1" opacity="0.6" />}
      {alarm !== undefined && alarm <= hi && <line x1="0" x2={width} y1={y(alarm)} y2={y(alarm)} stroke="var(--bad)" strokeDasharray="3 3" strokeWidth="1" opacity="0.6" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const ASSET_TONE: Record<AssetView["status"], string> = { running: "ok", idle: "", degraded: "warn", down: "bad", maintenance: "info" };
export const AssetStatus = ({ s }: { s: AssetView["status"] }) => (
  <span className={`pill ${ASSET_TONE[s]}`}>
    <span className="dot" />
    {s}
  </span>
);

const INC_TONE: Record<IncidentStatus, string> = { open: "warn", awaiting_approval: "warn", mitigated: "ok", closed: "" };
export const IncidentPill = ({ s }: { s: IncidentStatus }) => <span className={`pill ${INC_TONE[s]}`}>{s.replace("_", " ")}</span>;

export const Card = ({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) => (
  <div className="card">
    <div className="card-h">
      <h2>{title}</h2>
      {right}
    </div>
    <div className="card-b">{children}</div>
  </div>
);

export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const short = (h: string, n = 10) => (h.startsWith("sha256:") ? `${h.slice(7, 7 + n)}…` : h);
export const agentLabel = (a: string) =>
  a.startsWith("user:") ? a.slice(5) : a.startsWith("agent:") ? `${a.slice(6)[0]!.toUpperCase()}${a.slice(7)} agent` : a === "guard:policy" ? "Policy guard" : a;
