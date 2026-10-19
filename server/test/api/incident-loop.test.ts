import { afterEach, describe, expect, it } from "vitest";
import { makeSystem } from "../helpers.js";

const maint = { name: "R. Iyer", role: "maintenance_lead" };
const op = { name: "A. Shah", role: "operator" };
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function startBearingWear() {
  const t = await makeSystem({ SIM_SCENARIO: "bearing_wear" });
  close = t.sys.close;
  await t.sys.orchestrator.reset("bearing_wear", 42);
  t.sys.orchestrator.stop();
  await t.stepUntil(async () => (await t.call("GET", "/v1/approvals?status=pending")).body.length > 0, 40);
  return t;
}

describe("incident loop (offline agents, L3)", () => {
  it("detects, forecasts, diagnoses, auto-reroutes and asks the maintenance lead for the work order", async () => {
    const t = await startBearingWear();
    const [incident] = (await t.call("GET", "/v1/incidents")).body;
    expect(incident.assetId).toBe("CNC-05");
    expect(incident.status).toBe("awaiting_approval");

    const detail = (await t.call("GET", `/v1/incidents/${incident.id}`)).body;
    const kinds = detail.decisions.map((d: any) => d.kind);
    expect(kinds.slice(0, 4)).toEqual(["detect", "forecast", "diagnose", "recommend"]);
    expect(kinds).toContain("execute"); // reroute ≤ 100 units runs automatically at L3
    const exec = detail.decisions.find((d: any) => d.kind === "execute");
    expect(exec.data.action.tool).toBe("reroute_batch");
    expect(exec.agent).toBe("agent:healer");

    const [approval] = detail.approvals;
    expect(approval.action.tool).toBe("open_work_order");
    expect(approval.requiredRole).toBe("maintenance_lead");
    expect(approval.policy.ruleIds).toContain("R4-level-open_work_order");

    const plant = (await t.call("GET", "/v1/plant")).body;
    expect(plant.batches.find((b: any) => b.id === "B-2417").assetId).toBe("CNC-07");
  });

  it("enforces approval rights, executes once, pays the vendor, closes, anchors and verifies", async () => {
    const t = await startBearingWear();
    const [approval] = (await t.call("GET", "/v1/approvals?status=pending")).body;

    expect((await t.call("POST", `/v1/approvals/${approval.id}/approve`, { actor: op })).status).toBe(403);
    const ok = await t.call("POST", `/v1/approvals/${approval.id}/approve`, { actor: maint, reason: "Spares on hand" });
    expect(ok.status).toBe(200);
    expect((await t.call("POST", `/v1/approvals/${approval.id}/approve`, { actor: maint })).status).toBe(409);
    await t.sys.orchestrator.idle();

    const incident = (await t.call("GET", `/v1/incidents/${approval.incidentId}`)).body;
    expect(incident.incident.status).toBe("closed");
    expect(incident.incident.downtimeAvoidedMin).toBeGreaterThan(100);
    const types = incident.entries.map((e: any) => e.type);
    for (const t2 of ["incident.opened", "agent.forecast", "agent.diagnosis", "agent.recommendation", "policy.evaluated", "approval.requested", "approval.granted", "action.executed", "payment.sent", "evidence.stored", "incident.closed"])
      expect(types).toContain(t2);
    expect(types.filter((x: string) => x === "action.executed")).toHaveLength(2);

    const anchors = (await t.call("GET", "/v1/anchors")).body;
    expect(anchors.length).toBeGreaterThan(0);

    const v = (await t.call("GET", `/v1/verify/incidents/${approval.incidentId}`)).body;
    expect(v.ok).toBe(true);
    expect(v.anchor.ok).toBe(true);
    expect(v.policy.ok).toBe(true);
    expect(v.steps.every((s: any) => s.ok)).toBe(true);

    const seq = incident.entries[2].seq;
    const tampered = (await t.call("GET", `/v1/verify/incidents/${approval.incidentId}?tamper=${seq}`)).body;
    expect(tampered.ok).toBe(false);
    expect(tampered.steps.find((s: any) => s.seq === seq).ok).toBe(false);
    expect(tampered.anchor.ok).toBe(false);

    // The plant survives: maintenance happens, no unplanned failure.
    await t.stepUntil(() => t.sys.orchestrator.plant.minute > 160, 200);
    expect(t.sys.orchestrator.plant.failures).toEqual([]);
  });

  it("rejecting requires a reason and closes the incident without downtime credit", async () => {
    const t = await startBearingWear();
    const [approval] = (await t.call("GET", "/v1/approvals?status=pending")).body;
    expect((await t.call("POST", `/v1/approvals/${approval.id}/reject`, { actor: maint })).status).toBe(400);
    expect((await t.call("POST", `/v1/approvals/${approval.id}/reject`, { actor: maint, reason: "No spares until Monday" })).status).toBe(200);
    await t.sys.orchestrator.idle();
    const inc = (await t.call("GET", `/v1/incidents/${approval.incidentId}`)).body.incident;
    expect(inc.status).toBe("closed");
    expect(inc.downtimeAvoidedMin).toBe(0);
  });

  it("only the plant manager changes autonomy; at L4 the work order runs without a person", async () => {
    const t = await makeSystem({ SIM_SCENARIO: "bearing_wear" });
    close = t.sys.close;
    expect((await t.call("PATCH", "/v1/line/autonomy", { actor: op, level: "L4" })).status).toBe(403);
    expect((await t.call("PATCH", "/v1/line/autonomy", { actor: { name: "M. Okafor", role: "plant_manager" }, level: "L4" })).status).toBe(200);
    await t.sys.orchestrator.reset("bearing_wear", 42);
    t.sys.orchestrator.stop();
    await t.stepUntil(async () => (await t.call("GET", "/v1/incidents")).body[0]?.status === "closed", 40);
    expect((await t.call("GET", "/v1/approvals?status=pending")).body).toHaveLength(0);
  });

  it("a faulty sensor never opens an incident", async () => {
    const t = await makeSystem({ SIM_SCENARIO: "sensor_fault" });
    close = t.sys.close;
    await t.sys.orchestrator.reset("sensor_fault", 42);
    t.sys.orchestrator.stop();
    for (let i = 0; i < 40; i++) t.sys.orchestrator.step();
    await t.sys.orchestrator.idle();
    expect((await t.call("GET", "/v1/incidents")).body).toHaveLength(0);
  });

  it("shift summary cites ledger entries", async () => {
    const t = await startBearingWear();
    const s = (await t.call("POST", "/v1/summaries/shift")).body;
    expect(s.citedSeqs.length).toBeGreaterThan(0);
    expect(s.summary).toContain("#");
  });
});
