/** A compact line chart with optional warn/alarm bands. */
export function Spark({ points, warn, alarm, unit, height = 64 }: { points: { ts: number; value: number | null }[]; warn?: number; alarm?: number; unit?: string; height?: number }) {
  const pts = points.filter((p): p is { ts: number; value: number } => p.value !== null);
  const w = 320;
  if (pts.length < 2) return <div className="spark-empty faint small">{pts.length ? `${pts[0]!.value}${unit ? ` ${unit}` : ""} · one reading` : "No numeric readings in this window"}</div>;
  const xs = pts.map((p) => p.ts);
  const vals = pts.map((p) => p.value);
  const lo = Math.min(...vals, warn ?? Infinity, alarm ?? Infinity);
  const hi = Math.max(...vals, warn ?? -Infinity, alarm ?? -Infinity);
  const span = hi - lo || 1;
  const x = (t: number) => ((t - xs[0]!) / (xs.at(-1)! - xs[0]! || 1)) * (w - 4) + 2;
  const y = (v: number) => height - 4 - ((v - lo) / span) * (height - 8);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label="trend">
      {warn !== undefined && <line x1={0} x2={w} y1={y(warn)} y2={y(warn)} className="sp-warn" />}
      {alarm !== undefined && <line x1={0} x2={w} y1={y(alarm)} y2={y(alarm)} className="sp-alarm" />}
      <path d={d} className="sp-line" />
    </svg>
  );
}
