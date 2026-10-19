import { afterEach, describe, expect, it } from "vitest";
import { makeSystem, TICK } from "../helpers.js";

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
    const exec = detail.decisions.find((d: any) => d.kind === "execute");
    expect(exec.data.action.tool).toBe("reroute_batch");
    expect(exec.agent).toBe("agent:healer");

    const [approval] = detail.approvals;
    expect(approval.action.tool).toBe("open_work_order");
    expect(approval.requiredRole).toBe("maintenance_lead");
    expect(approval.policy.ruleIds).toContain("R4-level-open_work_order");

    // The reroute is durable: a fresh replay (new instance) sees the batch on CNC-07.
    const plant = await t.sys.spawn().view();
    expect(plant.batches.find((b) => b.id === "B-2417")!.assetId).toBe("CNC-07");
  });

  it("enforces approval rights, executes once, pays the vendor, closes, anchors and verifies", async () => {
    const t = await startBearingWear();
    const [approval] = (await t.call("GET", "/v1/approvals?status=pending")).body;

    expect((await t.call("POST", `/v1/approvals/${approval.id}/approve`, { actor: op })).status).toBe(403);
    expect((await t.call("POST", `/v1/approvals/${approval.id}/approve`, { actor: maint, reason: "Spares on hand" })).status).toBe(200);
    expect((await t.call("POST", `/v1/approvals/${approval.id}/approve`, { actor: maint })).status).toBe(409);

    const incident = (await t.call("GET", `/v1/incidents/${approval.incidentId}`)).body;
    expect(incident.incident.status).toBe("closed");
    expect(incident.incident.downtimeAvoidedMin).toBeGreaterThan(100);
    const types = incident.entries.map((e: any) => e.type);
    for (const ty of ["incident.opened", "agent.forecast", "agent.diagnosis", "agent.recommendation", "policy.evaluated", "approval.requested", "approval.granted", "action.executed", "payment.sent", "evidence.stored", "incident.closed"])
      expect(types).toContain(ty);
    expect(types.filter((x: string) => x === "action.executed")).toHaveLength(2);
    expect((await t.call("GET", "/v1/anchors")).body.length).toBeGreaterThan(0);

    const v = (await t.call("GET", `/v1/verify/incidents/${approval.incidentId}`)).body;
    expect(v.ok).toBe(true);
    expect(v.anchor.ok).toBe(true);
    expect(v.policy.ok).toBe(true);

    const seq = incident.entries[2].seq;
    const tampered = (await t.call("GET", `/v1/verify/incidents/${approval.incidentId}?tamper=${seq}`)).body;
    expect(tampered.ok).toBe(false);
    expect(tampered.steps.find((s: any) => s.seq === seq).ok).toBe(false);
    expect(tampered.anchor.ok).toBe(false);

    // The plant survives: maintenance happens, no unplanned failure, no repeat incident.
    await t.stepUntil(async () => (await t.sys.orchestrator.view()).minute > 160, 200);
    const plant = await t.sys.orchestrator.view();
    expect(plant.failures).toEqual([]);
    expect((await t.call("GET", "/v1/incidents")).body).toHaveLength(1);
  });

  it("rejecting requires a reason and closes the incident without downtime credit", async () => {
    const t = await startBearingWear();
    const [approval] = (await t.call("GET", "/v1/approvals?status=pending")).body;
    expect((await t.call("POST", `/v1/approvals/${approval.id}/reject`, { actor: maint })).status).toBe(400);
    expect((await t.call("POST", `/v1/approvals/${approval.id}/reject`, { actor: maint, reason: "No spares until Monday" })).status).toBe(200);
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
    await t.stepUntil(async () => (await t.call("GET", "/v1/incidents")).body[0]?.status === "closed", 40);
    expect((await t.call("GET", "/v1/approvals?status=pending")).body).toHaveLength(0);
  });

  it("a faulty sensor never opens an incident", async () => {
    const t = await makeSystem();
    close = t.sys.close;
    await t.sys.orchestrator.reset("sensor_fault", 42);
    for (let i = 0; i < 40; i++) {
      t.clock.t += TICK;
      await t.sys.orchestrator.advance();
    }
    expect((await t.call("GET", "/v1/incidents")).body).toHaveLength(0);
  });

  it("if nobody acts, the bearing fails and the failure is on the ledger", async () => {
    const t = await makeSystem();
    close = t.sys.close;
    await t.sys.orchestrator.reset("bearing_wear", 42);
    t.clock.t += 120 * TICK; // nobody polls for two plant hours, then one request arrives
    await t.sys.orchestrator.advance();
    const types = (await t.call("GET", "/v1/ledger?limit=50")).body.map((e: any) => e.type);
    expect(types).toContain("asset.failed");
  });

  it("shift summary cites ledger entries", async () => {
    const t = await startBearingWear();
    const s = (await t.call("POST", "/v1/summaries/shift")).body;
    expect(s.citedSeqs.length).toBeGreaterThan(0);
  });
});

describe("serverless behaviour", () => {
  it("two instances over one database: concurrent advances open exactly one incident", async () => {
    const t = await makeSystem();
    close = t.sys.close;
    const other = t.sys.spawn();
    await t.sys.orchestrator.reset("bearing_wear", 42);
    for (let i = 0; i < 40; i++) {
      t.clock.t += TICK;
      await Promise.all([t.sys.orchestrator.advance(), other.advance(), other.advance()]);
    }
    expect((await t.call("GET", "/v1/incidents")).body).toHaveLength(1);
  });

  it("an approval executed on one instance is replayed by another", async () => {
    const t = await startBearingWear();
    const other = t.sys.spawn();
    await other.view(); // warm its cache before the approval
    const [approval] = (await t.call("GET", "/v1/approvals?status=pending")).body;
    await t.sys.orchestrator.approve(approval.id, maint as any);
    t.clock.t += 20 * TICK;
    const v = await other.view();
    expect(v.assets.find((a) => a.id === "CNC-05")!.maintenanceAt).not.toBeNull();
  });

  it("pause freezes the plant clock and resume continues from the same minute", async () => {
    const t = await makeSystem();
    close = t.sys.close;
    await t.sys.orchestrator.reset("normal", 42);
    t.clock.t += 10 * TICK;
    await t.call("POST", "/v1/sim/pause");
    t.clock.t += 50 * TICK;
    expect((await t.sys.orchestrator.view()).minute).toBe(10);
    await t.call("POST", "/v1/sim/resume");
    t.clock.t += 5 * TICK;
    expect((await t.sys.orchestrator.view()).minute).toBe(15);
  });

  it("the live endpoint returns only what changed", async () => {
    const t = await startBearingWear();
    const first = (await t.call("GET", "/v1/live?since=0")).body;
    expect(first.entries.length).toBeGreaterThan(5);
    const head = Math.max(...first.entries.map((e: any) => e.seq));
    const next = (await t.call("GET", `/v1/live?since=${head}`)).body;
    expect(next.entries).toHaveLength(0);
    expect(next.plant.minute).toBeGreaterThan(0);
  });

  it("with a passcode, writes need the header and reads do not", async () => {
    const t = await makeSystem({}, { passcode: "letmein" });
    close = t.sys.close;
    expect((await t.call("GET", "/v1/plant")).status).toBe(200);
    expect((await t.call("POST", "/v1/sim/scenarios/normal/start")).status).toBe(401);
    expect((await t.call("POST", "/v1/sim/scenarios/normal/start", undefined, { "x-ordo-passcode": "nope" })).status).toBe(401);
    expect((await t.call("POST", "/v1/sim/scenarios/normal/start", undefined, { "x-ordo-passcode": "letmein" })).status).toBe(200);
  });
});
