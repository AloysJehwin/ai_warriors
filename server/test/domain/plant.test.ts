import { describe, expect, it } from "vitest";
import { detectAll } from "../../src/domain/detector.js";
import { forecast } from "../../src/domain/forecast.js";
import { Plant } from "../../src/domain/simulator.js";
import { downtimeAvoided } from "../../src/domain/downtime.js";
import type { TelemetrySample } from "../../src/domain/types.js";

function run(p: Plant, minutes: number): TelemetrySample[] {
  const all: TelemetrySample[] = [];
  for (let i = 0; i < minutes; i++) all.push(...p.tick());
  return all;
}
const firstAnomaly = (p: Plant, max: number) => {
  const seen: TelemetrySample[] = [];
  for (let i = 0; i < max; i++) {
    seen.push(...p.tick());
    const a = detectAll(seen.filter((s) => s.assetId === "CNC-05"));
    if (a) return { a, seen };
  }
  return null;
};

describe("simulator", () => {
  it("is deterministic for a seed and scenario", () => {
    expect(run(new Plant(42, "bearing_wear"), 20)).toEqual(run(new Plant(42, "bearing_wear"), 20));
    expect(run(new Plant(42, "bearing_wear"), 20)).not.toEqual(run(new Plant(7, "bearing_wear"), 20));
  });

  it("normal operation raises no anomaly for an hour", () => {
    const p = new Plant(42, "normal");
    const s = run(p, 60);
    for (const id of ["CNC-04", "CNC-05", "CNC-07"]) expect(detectAll(s.filter((x) => x.assetId === id))).toBeNull();
  });

  it("bearing wear is detected within 30 plant minutes and fails if ignored", () => {
    const p = new Plant(42, "bearing_wear");
    const hit = firstAnomaly(p, 30);
    expect(hit?.a.signal).toBe("vibration_rms");
    run(p, 200);
    expect(p.failures.map((f) => f.assetId)).toContain("CNC-05");
  });

  it("forecast on bearing wear predicts a near-term failure with high probability", () => {
    const p = new Plant(42, "bearing_wear");
    const hit = firstAnomaly(p, 30)!;
    const f = forecast(hit.seen, "CNC-05", "vibration_rms");
    expect(f.ttfHours).not.toBeNull();
    expect(f.ttfHours!).toBeGreaterThan(0.3);
    expect(f.ttfHours!).toBeLessThan(4);
    expect(f.pFailure24h).toBeGreaterThan(0.8);
    expect(f.confidence).toBeGreaterThan(0.7);
  });

  it("rerouting plus a work order prevents the failure", () => {
    const p = new Plant(42, "bearing_wear");
    firstAnomaly(p, 30);
    expect(p.apply({ tool: "reroute_batch", args: { batchId: "B-2417", targetAssetId: "CNC-07", units: 50 } }).ok).toBe(true);
    expect(p.apply({ tool: "open_work_order", args: { assetId: "CNC-05", priority: "high", windowMinutes: 15 } }).ok).toBe(true);
    run(p, 200);
    expect(p.failures).toEqual([]);
    expect(p.asset("CNC-05").wear).toBeLessThan(0.33);
    expect(p.batches.find((b) => b.id === "B-2417")!.assetId).toBe("CNC-07");
  });

  it("overheat is detected as a temperature alarm", () => {
    const p = new Plant(42, "overheat");
    const hit = firstAnomaly(p, 10);
    expect(hit?.a.signal).toBe("bearing_temp");
    expect(hit?.a.level).toBe("alarm");
  });

  it("a faulty sensor (quality bad) never triggers an anomaly", () => {
    const p = new Plant(42, "sensor_fault");
    const s = run(p, 40);
    const cnc04 = s.filter((x) => x.assetId === "CNC-04");
    expect(cnc04.some((x) => x.quality === "bad")).toBe(true);
    expect(detectAll(cnc04)).toBeNull();
  });

  it("downtime avoided is computed from its inputs", () => {
    expect(downtimeAvoided({ pFailure: 0.9, workOrderOpened: true })).toEqual({ minutes: 186, expectedUnplanned: 216, planned: 30 });
    expect(downtimeAvoided({ pFailure: 0.05, workOrderOpened: true }).minutes).toBe(0);
  });
});
