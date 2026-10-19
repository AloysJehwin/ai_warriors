import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, wallet, type Client, type System } from "./helpers.js";

let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let admin: Client;
let site = "";
let runId = "";
const S = () => `/v1/sites/${site}`;
const anon = async (path: string) => {
  const res = await app.request(path, { headers: { host: "localhost" } });
  return { status: res.status, json: await res.json() };
};

beforeAll(async () => {
  ({ sys, app } = await boot());
  admin = await wallet(app);
  site = (await admin.call("POST", "/v1/sites", { name: "Open Plant", timezone: "UTC", lineName: "Line 1", zones: [] })).json.id;
  const tpl = (await admin.call("GET", `${S()}/templates`)).json[0];
  runId = (await admin.call("POST", `${S()}/runs`, { templateVersionId: tpl.versionId, orderRef: "SO-SECRET-42", quantity: 12 })).json.id;
}, 60_000);
afterAll(async () => sys.close());

describe("public pipelines", () => {
  it("lists running pipelines without an account, with no order refs, addresses or names", async () => {
    const r = await anon("/v1/public/pipelines");
    expect(r.status).toBe(200);
    const p = r.json.find((x: any) => x.runId === runId);
    expect(p.site).toBe("Open Plant");
    expect(p.stages.length).toBeGreaterThan(0);
    expect(p.roles.map((x: any) => `${x.kind}:${x.role}`)).toEqual(expect.arrayContaining(["member:operator", "member:process_engineer", "validator:quality", "validator:plant"]));
    expect(p.roles.find((x: any) => x.role === "plant_manager")?.holders ?? 1).toBe(1);
    const text = JSON.stringify(r.json);
    expect(text).not.toContain("SO-SECRET-42");
    expect(text).not.toContain(admin.address);
    expect(text).not.toMatch(/0x[0-9a-f]{40}/i);
  });

  it("shows one pipeline with its validation, and 404s for another site's code", async () => {
    const r = await anon(`/v1/public/pipelines/${site}/${runId}`);
    expect(r.status).toBe(200);
    expect(r.json.validation).toEqual([]);
    expect((await anon(`/v1/public/pipelines/site_nope/${runId}`)).status).toBe(404);
  });

  it("a newcomer applies for a role from the pipeline; the admin sees where it came from", async () => {
    const newcomer = await wallet(app);
    const r = await newcomer.call("POST", "/v1/onboarding", { siteId: site, kind: "validator", role: "quality", form: { fullName: "New Person", qualifications: "CQE", pipeline: `run ${runId}` } });
    expect(r.status).toBe(200);
    const queue = (await admin.call("GET", `${S()}/onboarding?status=pending`)).json;
    expect(queue.find((x: any) => x.id === r.json.id).form.pipeline).toBe(`run ${runId}`);
  });

  it("an administrator can hide the site's pipelines from the public list", async () => {
    const patched = await admin.call("PATCH", S(), { publicPipelines: false });
    expect(patched.status).toBe(200);
    expect(patched.json.publicPipelines).toBe(false);
    expect((await anon("/v1/public/pipelines")).json.some((x: any) => x.siteId === site)).toBe(false);
    expect((await anon(`/v1/public/pipelines/${site}/${runId}`)).status).toBe(404);
    await admin.call("PATCH", S(), { publicPipelines: true });
    expect((await anon("/v1/public/pipelines")).json.some((x: any) => x.siteId === site)).toBe(true);
  });
});
