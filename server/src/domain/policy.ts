import { parse } from "yaml";
import { z } from "zod";
import { hashOf } from "./canonical.js";
import { AutonomyLevel, levelRank, Role, ToolCall as ToolCallSchema, type PolicyResult, type Quality } from "./types.js";

const ToolPolicy = z.object({
  autoFrom: AutonomyLevel,
  role: Role.optional(),
});

export const PolicySchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  confidenceThreshold: z.number().min(0).max(1),
  defaultRole: Role,
  tools: z.object({
    adjust_line_speed: ToolPolicy.extend({ minPct: z.number(), maxPct: z.number(), increaseRole: Role }),
    hold_gate: ToolPolicy,
    reroute_batch: ToolPolicy.extend({ autoMaxUnits: z.number().int().positive(), overLimitRole: Role, overLimitAutoFrom: AutonomyLevel }),
    open_work_order: ToolPolicy,
    request_inspection: ToolPolicy,
  }),
});
export type Policy = z.infer<typeof PolicySchema>;

export function loadPolicy(yamlText: string): { policy: Policy; hash: string } {
  const policy = PolicySchema.parse(parse(yamlText));
  return { policy, hash: hashOf(policy) };
}

export interface GuardContext {
  level: AutonomyLevel;
  confidence: number;
  inputQuality: Quality[];
  knownAssets: string[];
}

const ROLE_RANK: Record<Role, number> = { operator: 1, quality_engineer: 2, maintenance_lead: 3, plant_manager: 4 };
export const canApprove = (actor: Role, required: Role): boolean => actor === required || actor === "plant_manager" || ROLE_RANK[actor] > ROLE_RANK[required];

/**
 * Policy guard: a pure function. Every proposed action, from an agent or a person, passes
 * through here. Result: allow, require approval (by which role), or block.
 */
export function evaluate(action: unknown, ctx: GuardContext, policy: Policy, policyHash: string): PolicyResult {
  const base = { policyVersion: policy.version, policyHash };
  const block = (ruleId: string, explanation: string): PolicyResult => ({ outcome: "block", ruleIds: [ruleId], explanation, ...base });

  const rules: string[] = [];
  const reasons: string[] = [];
  let role: Role | undefined;
  const need = (ruleId: string, r: Role, why: string) => {
    rules.push(ruleId);
    reasons.push(why);
    if (!role || ROLE_RANK[r] > ROLE_RANK[role]) role = r;
  };

  // R0: only allow-listed tools exist. Anything else (incl. safety functions) is blocked.
  const parsed = ToolCallSchema.safeParse(action);
  if (!parsed.success) return block("R0-unknown-or-invalid-tool", "Action is not an allow-listed tool with valid arguments; safety functions are never callable.");
  const call = parsed.data;

  // R1: hard ranges and scope.
  const assetArg = "assetId" in call.args ? call.args.assetId : "targetAssetId" in call.args ? call.args.targetAssetId : null;
  if (assetArg && !ctx.knownAssets.includes(assetArg)) return block("R1-out-of-scope", `Asset ${assetArg} is not on this line.`);
  if (call.tool === "adjust_line_speed") {
    const t = policy.tools.adjust_line_speed;
    if (call.args.pctChange < t.minPct || call.args.pctChange > t.maxPct)
      return block("R1-out-of-range", `Speed change ${call.args.pctChange}% is outside the allowed ${t.minPct}…+${t.maxPct}%.`);
  }

  // R2: data quality. Uncertain or bad inputs always go to a person.
  if (ctx.inputQuality.some((q) => q !== "good")) need("R2-data-quality", policy.defaultRole, "Some input data is not good quality.");
  // R3: confidence threshold.
  if (ctx.confidence < policy.confidenceThreshold)
    need("R3-low-confidence", policy.defaultRole, `Confidence ${ctx.confidence.toFixed(2)} is below ${policy.confidenceThreshold}.`);

  // R4: autonomy level vs the tool's auto threshold.
  const tp = policy.tools[call.tool];
  if (levelRank(ctx.level) < levelRank(tp.autoFrom))
    need(`R4-level-${call.tool}`, tp.role ?? policy.defaultRole, `${call.tool} runs automatically only from ${tp.autoFrom}; line is at ${ctx.level}.`);

  // R5: tool-specific limits.
  if (call.tool === "adjust_line_speed" && call.args.pctChange > 0)
    need("R5-speed-increase", policy.tools.adjust_line_speed.increaseRole, "Any line-speed increase needs the plant manager.");
  if (call.tool === "reroute_batch") {
    const t = policy.tools.reroute_batch;
    if (call.args.units > t.autoMaxUnits && levelRank(ctx.level) < levelRank(t.overLimitAutoFrom))
      need("R5-reroute-volume", t.overLimitRole, `Rerouting ${call.args.units} units exceeds the ${t.autoMaxUnits}-unit limit.`);
  }

  if (rules.length === 0) return { outcome: "allow", ruleIds: ["R9-in-policy"], explanation: `Within policy at ${ctx.level}.`, ...base };
  return { outcome: "require_approval", role: role ?? policy.defaultRole, ruleIds: rules, explanation: reasons.join(" "), ...base };
}

