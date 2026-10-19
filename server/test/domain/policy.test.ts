import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canApprove, evaluate, loadPolicy, type GuardContext } from "../../src/domain/policy.js";
import { LEVELS, type AutonomyLevel, type ToolCall } from "../../src/domain/types.js";

const { policy, hash } = loadPolicy(readFileSync(new URL("../../../policies/default.yaml", import.meta.url), "utf8"));
const ctx = (level: AutonomyLevel, over: Partial<GuardContext> = {}): GuardContext => ({ level, confidence: 0.9, inputQuality: ["good"], knownAssets: ["A1", "A2"], ...over });

const A = {
  hold: { tool: "hold_stage", args: { runId: "R-0001", stageCode: "06", reason: "Cpk below limit" } },
  reassign: { tool: "reassign_stage", args: { runId: "R-0001", stageCode: "03a", targetAssetId: "A2" } },
  workOrder: { tool: "open_work_order", args: { assetId: "A1", priority: "high", windowMinutes: 30 } },
  inspect: { tool: "request_inspection", args: { assetId: "A1", sampleRatePct: 100 } },
  notify: { tool: "notify_operator", args: { assetId: "A1", instruction: "Reduce feed override to 80% until maintenance" } },
} satisfies Record<string, ToolCall>;

// a = allow, s = supervisor, m = maintenance lead, q = quality engineer
const MATRIX: Record<keyof typeof A, [string, string, string, string]> = {
  hold: ["s", "s", "a", "a"],
  reassign: ["s", "s", "a", "a"],
  workOrder: ["m", "m", "m", "a"],
  inspect: ["q", "q", "a", "a"],
  notify: ["s", "a", "a", "a"],
};
const decode = { a: ["allow", undefined], s: ["require_approval", "supervisor"], m: ["require_approval", "maintenance_lead"], q: ["require_approval", "quality_engineer"] } as const;

describe("policy guard matrix", () => {
  for (const [name, row] of Object.entries(MATRIX))
    LEVELS.forEach((level, i) => {
      it(`${name} at ${level} → ${row[i]}`, () => {
        const r = evaluate(A[name as keyof typeof A], ctx(level), policy, hash);
        const [outcome, role] = decode[row[i] as keyof typeof decode];
        expect(r.outcome).toBe(outcome);
        expect(r.role).toBe(role);
        expect(r.policyHash).toBe(hash);
      });
    });
});

describe("policy guard safety rules", () => {
  it("blocks anything that is not an allow-listed tool, at every level", () => {
    for (const level of LEVELS) expect(evaluate({ tool: "override_interlock", args: {} }, ctx(level), policy, hash).outcome).toBe("block");
  });
  it("blocks unknown assets", () => {
    expect(evaluate({ ...A.workOrder, args: { ...A.workOrder.args, assetId: "ZZ" } }, ctx("L4"), policy, hash).outcome).toBe("block");
  });
  it("escalates low confidence and bad data even at L4", () => {
    expect(evaluate(A.hold, ctx("L4", { confidence: 0.4 }), policy, hash).ruleIds).toContain("R3-low-confidence");
    expect(evaluate(A.hold, ctx("L4", { inputQuality: ["bad"] }), policy, hash).ruleIds).toContain("R2-data-quality");
  });
  it("approval rights: same role or higher", () => {
    expect(canApprove("operator", "supervisor")).toBe(false);
    expect(canApprove("plant_manager", "quality_engineer")).toBe(true);
    expect(canApprove("quality_engineer", "quality_engineer")).toBe(true);
    expect(canApprove("maintenance_lead", "quality_engineer")).toBe(false);
  });
});
