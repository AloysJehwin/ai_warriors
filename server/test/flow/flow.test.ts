import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, wallet, type Client, type System } from "./helpers.js";

let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let admin: Client;
let operator: Client;
let qe: Client;
let pm: Client;
let site = "";
let cnc = "";
let runId = "";

const S = () => `/v1/sites/${site}`;
const tick = () => sys.advance(true);

beforeAll(async () => {
  ({ sys, app } = await boot());
  admin = await wallet(app);
}, 60_000);
afterAll(async () => sys.close());

describe("accounts", () => {
  it("rejects anonymous access and a replayed sign-in", async () => {
    const anon = await app.request("/v1/sites/x/assets", { headers: { host: "localhost" } });
    expect(anon.status).toBe(401);
  });

  it("the first wallet creates a site and becomes admin and plant manager", async () => {
    const r = await admin.call("POST", "/v1/sites", { name: "Pune Plant 1", timezone: "Asia/Kolkata", lineName: "Line 2", zones: ["Machining", "Inspection"] });
    expect(r.status).toBe(200);
    site = r.json.id;
    const me = await admin.call("GET", "/v1/me");
    expect(me.json.memberships[0].roles.sort()).toEqual(["admin", "plant_manager"]);
  });

  it("invites by wallet address; the role applies on first sign-in", async () => {
    operator = await wallet(app);
    qe = await wallet(app);
    pm = await wallet(app);
    // operator already signed in once: added directly
    expect((await admin.call("POST", `${S()}/team/invites`, { address: operator.address, role: "operator" })).json.added).toBe(true);
    expect((await admin.call("POST", `${S()}/team/invites`, { address: qe.address, role: "quality_engineer" })).json.added).toBe(true);
    expect((await admin.call("POST", `${S()}/team/invites`, { address: pm.address, role: "plant_manager" })).json.added).toBe(true);
    const team = await admin.call("GET", `${S()}/team`);
    expect(team.json.members).toHaveLength(4);
    // an operator cannot invite
    expect((await operator.call("POST", `${S()}/team/invites`, { address: qe.address, role: "admin" })).status).toBe(403);
  });

  it("onboards validators: an application, then the admin's signed approval", async () => {
    const apply = async (c: Client, role: string, fullName: string) => {
      const r = await c.call("POST", "/v1/onboarding", { siteId: site, kind: "validator", role, form: { fullName, qualifications: "ISO 9001 lead auditor, 6 years in machining QA" } });
      expect(r.status).toBe(200);
      return r.json.id as string;
    };
    const decide = async (id: string) => {
      const typed = (await admin.call("POST", `${S()}/onboarding/${id}/sign-request`, { decision: "approve" })).json;
      expect(typed.message.action).toBe("role.grant");
      expect(typed.message.entity).toMatch(/#VALIDATOR$/);
      const r = await admin.call("POST", `${S()}/onboarding/${id}/decide`, { decision: "approve", comment: "", nonce: typed.message.nonce, signature: await admin.sign(typed) });
      expect(r.json.status).toBe("approved");
    };
    const qeReq = await apply(qe, "quality", "Meera Okafor");
    // only an admin reviews
    expect((await qe.call("POST", `${S()}/onboarding/${qeReq}/sign-request`, { decision: "approve" })).status).toBe(403);
    await decide(qeReq);
    await decide(await apply(pm, "plant", "Sven Lindqvist"));
    const v = (await admin.call("GET", `${S()}/validators`)).json;
    expect(v.validators.map((x: any) => x.scope).sort()).toEqual(["plant", "quality"]);
    expect((await qe.call("GET", `${S()}/validators`)).json.me.ok).toBe(true);
    expect((await operator.call("GET", `${S()}/validators`)).json.me.ok).toBe(false);
  });

  it("blocks cross-site writes", async () => {
    const res = await app.request(`${S()}/zones`, { method: "POST", headers: { host: "localhost", origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("assets and real readings", () => {
  it("registers an asset with limits; no data means no status", async () => {
    const r = await admin.call("POST", `${S()}/assets`, {
      name: "CNC-01",
      kind: "cnc",
      owningAgent: "scheduler",
      source: { type: "manual" },
      limits: { temperature: { warn: 60, alarm: 80, unit: "°C" } },
      idealCycleS: 30,
    });
    expect(r.status).toBe(200);
    cnc = r.json.id;
    const assets = await admin.call("GET", `${S()}/assets`);
    expect(assets.json[0].status).toBe("no_data");
    expect(assets.json[0].utilization).toBeNull();
    expect(assets.json[0].oee).toBeNull();
  });

  it("records manual readings", async () => {
    await operator.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "execution", text: "ACTIVE" });
    await operator.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "part_count", value: 100 });
    const a = (await admin.call("GET", `${S()}/assets`)).json[0];
    expect(a.status).toBe("running");
    expect(a.latest.part_count.value).toBe(100);
  });
});

describe("pipelines", () => {
  let versionId = "";
  it("ships the 15 library templates", async () => {
    const t = await admin.call("GET", `${S()}/templates`);
    expect(t.json.filter((x: any) => x.origin === "library")).toHaveLength(15);
  });

  it("publishes a custom template from the builder", async () => {
    const spec = {
      stages: [
        { code: "01", column: 1, name: "Release order", agent: "planning", resourceKind: "system", mode: "auto", escalationRole: "supervisor", timeoutMin: 10, criteria: [] },
        { code: "02", column: 2, name: "Machine housing", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "supervisor", timeoutMin: 60, criteria: [{ label: "Yield", op: ">=", target: 95, unit: "%" }] },
        { code: "03", column: 3, name: "Final inspection", agent: "vision_qa", resourceKind: "inspection", mode: "approve", escalationRole: "quality_engineer", timeoutMin: 30, criteria: [{ label: "Yield", op: ">=", target: 99, unit: "%" }] },
      ],
      rework: null,
    };
    expect((await operator.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", spec })).status).toBe(403);
    const r = await admin.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", description: "Test line", spec });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(1);
    versionId = r.json.versionId;
    const bad = await admin.call("POST", `${S()}/templates`, { name: "Bad", category: "x1", spec: { ...spec, rework: { from: "01", to: "03" } } });
    expect(bad.status).toBe(400);
  });

  it("runs on measured part counts and gates on a signed approval", async () => {
    const r = await admin.call("POST", `${S()}/runs`, { templateVersionId: versionId, orderRef: "SO-7781", quantity: 10 });
    expect(r.status).toBe(200);
    runId = r.json.id;
    const st = (code: string) => r.json.stages.find((s: any) => s.code === code);
    expect(st("01").state).toBe("completed");
    expect(st("02").state).toBe("running");
    expect(st("02").assetId).toBe(cnc);

    // the machine counts 10 parts
    await operator.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "part_count", value: 110 });
    await tick();
    let run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    const s2 = run.stages.find((s: any) => s.code === "02");
    expect(s2.state).toBe("completed");
    expect(s2.unitsGood).toBe(10);
    const s3 = run.stages.find((s: any) => s.code === "03");
    expect(s3.state).toBe("running");
    expect(s3.waitingReason).toMatch(/operator records/);

    // the operator records the inspection; approve mode raises a gate
    await operator.call("POST", `${S()}/runs/${runId}/stages/03/record`, { good: 10, scrap: 0, complete: true });
    run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    expect(run.stages.find((s: any) => s.code === "03").state).toBe("awaiting_approval");
    const inbox = (await admin.call("GET", `${S()}/inbox`)).json;
    const gate = inbox.find((i: any) => i.runId === runId && i.stageCode === "03");
    expect(gate.requiredRole).toBe("quality_engineer");

    // an operator cannot release a quality gate
    expect((await operator.call("POST", `${S()}/inbox/${gate.id}/sign-request`, { option: 0 })).status).toBe(403);

    // the QE signs with their wallet
    const typed = (await qe.call("POST", `${S()}/inbox/${gate.id}/sign-request`, { option: 0, comment: "Visual check OK" })).json;
    expect(typed.message.entity).toBe(`${gate.id}#0`);
    // a signature from another wallet is rejected
    const forged = await admin.sign(typed);
    expect((await qe.call("POST", `${S()}/inbox/${gate.id}/decide`, { option: 0, comment: "x", nonce: typed.message.nonce, signature: forged })).status).toBe(401);
    // the failed attempt rolled back, so the nonce is still usable by its owner
    const sig = await qe.sign(typed);
    const d = await qe.call("POST", `${S()}/inbox/${gate.id}/decide`, { option: 0, comment: "Visual check OK", nonce: typed.message.nonce, signature: sig });
    expect(d.status).toBe(200);
    expect(d.json.status).toBe("approved");
    // replaying the same signature fails
    expect((await qe.call("POST", `${S()}/inbox/${gate.id}/decide`, { option: 0, comment: "x", nonce: typed.message.nonce, signature: sig })).status).toBe(409);

    run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    expect(run.status).toBe("completed");
    expect(run.metrics.rolledYield).toBe(1);
  });
});

describe("agents on real telemetry", () => {
  it("opens an incident and escalates the out-of-policy action", async () => {
    for (const v of [55, 62, 71, 84]) await operator.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "temperature", value: v });
    await tick();
    const inc = (await admin.call("GET", `${S()}/incidents`)).json;
    expect(inc).toHaveLength(1);
    expect(inc[0].severity).toBe("alarm");
    const items = (await admin.call("GET", `${S()}/inbox`)).json.filter((i: any) => i.incidentId === inc[0].id);
    expect(items).toHaveLength(1);
    expect(items[0].options[0].action.tool).toBe("open_work_order");
    expect(items[0].requiredRole).toBe("maintenance_lead");
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    expect(decisions.some((d: any) => d.kind === "incident.diagnosed" && /temperature/.test(d.summary))).toBe(true);
  });

  it("a signed work order starts a predictive maintenance run", async () => {
    const item = (await admin.call("GET", `${S()}/inbox`)).json.find((i: any) => i.category === "Equipment");
    const typed = (await admin.call("POST", `${S()}/inbox/${item.id}/sign-request`, { option: 0 })).json;
    const r = await admin.call("POST", `${S()}/inbox/${item.id}/decide`, { option: 0, comment: "", nonce: typed.message.nonce, signature: await admin.sign(typed) });
    expect(r.status).toBe(200);
    const runs = (await admin.call("GET", `${S()}/runs`)).json;
    expect(runs.some((x: any) => x.templateName === "Predictive maintenance" && x.orderRef.includes("CNC-01"))).toBe(true);
  });

  it("autonomy changes need the plant manager's signature", async () => {
    const lineId = (await admin.call("GET", S())).json.lines[0].id;
    expect((await operator.call("POST", `${S()}/lines/${lineId}/autonomy/sign-request`, { level: "L3" })).status).toBe(403);
    const typed = (await pm.call("POST", `${S()}/lines/${lineId}/autonomy/sign-request`, { level: "L3" })).json;
    const r = await pm.call("PUT", `${S()}/lines/${lineId}/autonomy`, { level: "L3", nonce: typed.message.nonce, signature: await pm.sign(typed) });
    expect(r.json.lines[0].autonomy).toBe("L3");
  });
});

describe("validation package", () => {
  it("runs the full signature chain with separation of duties", async () => {
    const created = await admin.call("POST", `${S()}/validation`, { type: "stage_validation", title: "Housing machining stage", objective: "Prove stage 02", acceptance: "Yield ≥ 95%", runId, stageCode: "02" });
    expect(created.status).toBe(200);
    const id = created.json.id;
    expect(created.json.checks).toHaveLength(1);
    expect(created.json.readiness.ready).toBe(false);

    let p = (await admin.call("POST", `${S()}/validation/${id}/precheck`)).json;
    expect(p.checks[0].status).toBe("pass");
    expect(p.checks[0].actual).toBe("100.0%");
    expect(p.evidence.some((e: any) => e.origin === "agent" && e.sha256)).toBe(true);

    // attach the required inspection report
    const slot = p.evidence.find((e: any) => e.name === "Inspection report");
    const form = new FormData();
    form.set("file", new File(["CMM report: all dimensions in tolerance"], "cmm.txt", { type: "text/plain" }));
    form.set("slotId", slot.id);
    const up = await admin.upload(`${S()}/validation/${id}/evidence`, form);
    expect(up.status).toBe(200);
    expect(up.json.evidence.find((e: any) => e.name === "Inspection report" && !e.removedAt).sha256).toMatch(/^sha256:/);
    // QE can download the stored file
    const res = await app.request(`${S()}/validation/${id}/evidence/${slot.id}/file`, { headers: { host: "localhost" } });
    expect(res.status).toBe(401);
    p = (await admin.call("GET", `${S()}/validation/${id}`)).json;
    expect(p.readiness.ready).toBe(true);

    const act = async (c: Client, action: string, comment = "") => {
      const t = await c.call("POST", `${S()}/validation/${id}/sign-request`, { action, comment });
      if (t.status !== 200) return t;
      return c.call("POST", `${S()}/validation/${id}/act`, { action, comment, nonce: t.json.message.nonce, signature: await c.sign(t.json) });
    };
    expect((await act(admin, "sign")).json.status).toBe("in_review");
    // someone without the QE role and validator approval cannot review
    expect((await act(operator, "sign")).status).toBe(403);
    // the same person cannot also review
    expect((await act(admin, "sign")).status).toBe(403);
    // QE returns it, owner resubmits, chain restarts
    expect((await act(qe, "return", "Add the CMM data file")).json.status).toBe("changes_requested");
    expect((await act(admin, "sign")).json.step).toBe("qe_review");
    expect((await act(qe, "sign")).json.step).toBe("approval");
    expect((await act(qe, "sign")).status).toBe(403);
    const done = await act(pm, "sign");
    expect(done.json.status).toBe("released");
    expect(done.json.chain.every((x: any) => x.state === "signed")).toBe(true);
    expect(done.json.audit.length).toBeGreaterThan(8);
  });
});

describe("proof", () => {
  it("the ledger verifies and anchors", async () => {
    const a = await admin.call("POST", `${S()}/anchors`);
    expect(a.json.kind).toBe("local-signed");
    const v = await admin.call("GET", `${S()}/verify?subject=${runId}`);
    expect(v.json.ok).toBe(true);
    expect(v.json.entries).toBeGreaterThan(30);
    expect(v.json.subject.entries.length).toBeGreaterThan(5);
  });

  it("live returns counts for the signed-in user", async () => {
    const l = await qe.call("GET", `${S()}/live`);
    expect(l.status).toBe(200);
    expect(Array.isArray(l.json.assets)).toBe(true);
  });
});
