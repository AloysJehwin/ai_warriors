import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canApprove, evaluate, loadPolicy, type GuardContext } from "../../src/domain/policy.js";
import { LEVELS, type AutonomyLevel, type ToolCall } from "../../src/domain/types.js";

const { policy, hash } = loadPolicy(readFileSync(new URL("../../../policies/line-02.v1.yaml", import.meta.url), "utf8"));
const ctx = (level: AutonomyLevel, over: Partial<GuardContext> = {}): GuardContext => ({
  level,
  confidence: 0.9,
  inputQuality: ["good"],
  knownAssets: ["CNC-04", "CNC-05", "CNC-07"],
  ...over,
});

const A = {
  slow: { tool: "adjust_line_speed", args: { lineId: "LINE-02", pctChange: -10 } },
  faster: { tool: "adjust_line_speed", args: { lineId: "LINE-02", pctChange: 5 } },
  tooSlow: { tool: "adjust_line_speed", args: { lineId: "LINE-02", pctChange: -40 } },
  hold: { tool: "hold_gate", args: { batchId: "B-2417", reason: "vision defect" } },
  reroute60: { tool: "reroute_batch", args: { batchId: "B-2417", targetAssetId: "CNC-07", units: 60 } },
  reroute150: { tool: "reroute_batch", args: { batchId: "B-2417", targetAssetId: "CNC-07", units: 150 } },
  workOrder: { tool: "open_work_order", args: { assetId: "CNC-05", priority: "high", windowMinutes: 20 } },
  inspect: { tool: "request_inspection", args: { assetId: "CNC-05", sampleRatePct: 100 } },
} satisfies Record<string, ToolCall>;

// Expected outcome per action per level: a = allow, o = operator, m = maintenance lead, p = plant manager, x = block
const MATRIX: Record<keyof typeof A, [string, string, string, string]> = {
  slow: ["o", "o", "a", "a"],
  faster: ["p", "p", "p", "p"],
  tooSlow: ["x", "x", "x", "x"],
  hold: ["o", "o", "a", "a"],
  reroute60: ["o", "o", "a", "a"],
  reroute150: ["p", "p", "p", "a"],
  workOrder: ["m", "m", "m", "a"],
  inspect: ["o", "o", "a", "a"],
};
const decode = { a: ["allow", undefined], o: ["require_approval", "operator"], m: ["require_approval", "maintenance_lead"], p: ["require_approval", "plant_manager"], x: ["block", undefined] } as const;

describe("policy guard matrix", () => {
  for (const [name, row] of Object.entries(MATRIX)) {
    LEVELS.forEach((level, i) => {
      it(`${name} at ${level} → ${row[i]}`, () => {
        const r = evaluate(A[name as keyof typeof A], ctx(level), policy, hash);
        const [outcome, role] = decode[row[i] as keyof typeof decode];
        expect(r.outcome).toBe(outcome);
        expect(r.role).toBe(role);
        expect(r.policyVersion).toBe(1);
        expect(r.policyHash).toBe(hash);
      });
    });
  }
});

describe("policy guard safety rules", () => {
  it("blocks anything that is not an allow-listed tool, at every level", () => {
    for (const level of LEVELS) {
      expect(evaluate({ tool: "override_safety_interlock", args: {} }, ctx(level), policy, hash).outcome).toBe("block");
      expect(evaluate({ tool: "reroute_batch", args: { batchId: "B" } }, ctx(level), policy, hash).outcome).toBe("block");
    }
  });
  it("blocks assets outside the line", () => {
    expect(evaluate({ tool: "open_work_order", args: { assetId: "CNC-99", priority: "low", windowMinutes: 5 } }, ctx("L4"), policy, hash).outcome).toBe("block");
  });
  it("escalates low confidence even at L4", () => {
    const r = evaluate(A.slow, ctx("L4", { confidence: 0.5 }), policy, hash);
    expect(r.outcome).toBe("require_approval");
    expect(r.ruleIds).toContain("R3-low-confidence");
  });
  it("escalates bad input data even at L4", () => {
    const r = evaluate(A.hold, ctx("L4", { inputQuality: ["good", "bad"] }), policy, hash);
    expect(r.outcome).toBe("require_approval");
    expect(r.ruleIds).toContain("R2-data-quality");
  });
  it("a higher level never turns a block into an allow", () => {
    expect(LEVELS.map((l) => evaluate(A.tooSlow, ctx(l), policy, hash).outcome)).toEqual(["block", "block", "block", "block"]);
  });
  it("approval rights: same role or higher", () => {
    expect(canApprove("operator", "operator")).toBe(true);
    expect(canApprove("operator", "maintenance_lead")).toBe(false);
    expect(canApprove("plant_manager", "maintenance_lead")).toBe(true);
  });
});
