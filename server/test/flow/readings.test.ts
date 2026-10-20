import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgeMessage } from "../../src/core/readings.js";
import { holds, slotOf } from "../../src/core/stage-proofs.js";
import { Gateway } from "../../src/edge/gateway.js";
import { asTyped, boot, wallet, type Client, type System } from "./helpers.js";

/**
 * Proof of work without a chain: a machine's gateway pushes its counters and signs each finished stage's counts, an
 * operator signs a manual stage's, and Ordo proves each stage's criteria from the signed commitment.
 */
describe("signed stage readings and stage proofs", () => {
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let admin: Client;
  let operator: Client;
  let site = "";
  let runId = "";
  let asset = "";
  let gw: Gateway;
  const S = () => `/v1/sites/${site}`;

  beforeAll(async () => {
    ({ sys, app } = await boot());
    admin = await wallet(app);
    operator = await wallet(app);
    site = (await admin.call("POST", "/v1/sites", { name: "Edge Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
    await admin.call("POST", `${S()}/team/invites`, { address: operator.address, role: "operator" });
    const key = generatePrivateKey();
    asset = (await admin.call("POST", `${S()}/assets`, { name: "CNC-07", kind: "cnc", owningAgent: "scheduler", source: { type: "gateway", device: privateKeyToAccount(key).address }, limits: {}, idealCycleS: 30 })).json.id;
    // the gateway talks to the app in-process; a simulated machine making a good part every 6 s
    // the gateway's clock starts a minute back, so its first sample predates the run
    let clock = Date.now() - 61_000;
    gw = new Gateway({ url: "http://localhost", key, assetId: asset, source: { kind: "simulate", cycleS: 6, scrapEvery: 0 }, fetch: ((u: string, init: RequestInit) => app.request(new URL(u).pathname, { ...init, headers: { ...(init.headers as Record<string, string>), host: "localhost" } })) as never, now: () => clock });
    await gw.observe();
    const spec = {
      stages: [
        { code: "01", column: 1, name: "Machine housing", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "supervisor", timeoutMin: 120, criteria: [{ label: "Yield", op: ">=", target: 95, unit: "%" }, { label: "Cycle time", op: "<=", target: 7, unit: "s" }] },
        { code: "02", column: 2, name: "Inspect", agent: "vision_qa", resourceKind: "manual_station", mode: "manual", escalationRole: "supervisor", timeoutMin: 60, criteria: [{ label: "Scrap", op: "<=", target: 5, unit: "%" }] },
      ],
      rework: null,
    };
    const tpl = await admin.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", description: "Edge test", spec });
    const versionId = tpl.json.versionId;
    runId = (await admin.call("POST", `${S()}/runs`, { templateVersionId: versionId, orderRef: "SO-9", quantity: 10 })).json.id;
    // ten cycles later the machine has made ten parts
    clock = Date.now();
    await gw.observe();
    await sys.advance(true);
  }, 120_000);
  afterAll(async () => sys?.close());

  it("refuses requests not signed by the asset's gateway", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const ts = Math.floor(Date.now() / 1000);
    const h = (nonce: string, t = ts) => ({ host: "localhost", "x-ordo-device": stranger.address, "x-ordo-ts": String(t), "x-ordo-nonce": nonce, "x-ordo-sig": "" });
    const sig = await stranger.signMessage({ message: edgeMessage(ts, "nonce-0001", "GET", "/v1/edge/stages", "") });
    // a valid signature from a key that is no asset's gateway
    expect((await app.request("/v1/edge/stages", { headers: { ...h("nonce-0001"), "x-ordo-sig": sig } })).status).toBe(403);
    // replayed, stale, or signed for another nonce
    expect((await app.request("/v1/edge/stages", { headers: { ...h("nonce-0001"), "x-ordo-sig": sig } })).status).toBe(401);
    expect((await app.request("/v1/edge/stages", { headers: { ...h("nonce-0002", ts - 3600), "x-ordo-sig": sig } })).status).toBe(401);
    expect((await app.request("/v1/edge/stages", { headers: { ...h("nonce-0003"), "x-ordo-sig": sig } })).status).toBe(401);
  });

  it("the gateway signs the finished stage's counts from its own counters, and Ordo proves the criteria", async () => {
    const run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    expect(run.stages.find((s: any) => s.code === "01")).toMatchObject({ unitsGood: 10, workDoneAt: expect.any(String) });
    const signed = await gw.signFinished();
    expect(signed).toEqual([{ stage: "01", runId, matches: true }]);
    await sys.stageProofs.reconcile();
    const proofs = (await admin.call("GET", `${S()}/runs/${runId}/proofs`)).json.stages;
    expect(proofs).toEqual([expect.objectContaining({ stage: "01", status: "proven", verified: true, signerKind: "device", criteria: ["Yield", "Cycle time"] })]);
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    const d = decisions.find((x: any) => x.kind === "stage.reading_signed");
    expect(d.data).toMatchObject({ signerKind: "device", matches: true });
    expect(JSON.stringify(d.data)).not.toMatch(/"good"|salt/);
    // only once per stage
    expect(await gw.signFinished()).toEqual([]);
  }, 120_000);

  it("an operator signs a manual stage's counts; counts that miss a criterion are not proven", async () => {
    await operator.call("POST", `${S()}/runs/${runId}/stages/02/record`, { good: 9, scrap: 1, complete: true });
    // a gateway machine's stage is signed by its gateway, not a person
    expect((await operator.call("POST", `${S()}/runs/${runId}/stages/01/reading/sign-request`, { good: 10, scrap: 0 })).status).toBe(409);
    const req = (await operator.call("POST", `${S()}/runs/${runId}/stages/02/reading/sign-request`, { good: 9, scrap: 1 })).json;
    expect(req.typed.primaryType).toBe("OrdoReading");
    const m = req.typed.message;
    const signature = await operator.account.signTypedData(asTyped(req.typed));
    const r = await operator.call("POST", `${S()}/runs/${runId}/stages/02/reading`, { good: 9, scrap: 1, salt: req.salt, commitment: m.commitment, anchor: m.anchor, signedAt: Number(m.signedAt), signature });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ signer: operator.address, matches: true });
    await sys.stageProofs.reconcile();
    const proofs = (await admin.call("GET", `${S()}/runs/${runId}/proofs`)).json.stages;
    // 10 % scrap misses "scrap ≤ 5 %": nothing is proven, and the reason is shown
    expect(proofs.find((p: any) => p.stage === "02")).toMatchObject({ status: "not_met", signerKind: "operator", proof: null, detail: expect.stringMatching(/Scrap/) });
  }, 120_000);

  it("maps criteria to the circuit's comparisons exactly", () => {
    const y = slotOf({ label: "Yield", op: ">=", target: 98.5, unit: "%" } as never)!;
    expect(y).toMatchObject({ kind: 1n, op: 0n, target: 985_000n });
    expect(holds(y, { good: 197n, scrap: 3n, startedAt: 0n, endedAt: 1n })).toBe(true); // 98.5 %
    expect(holds(y, { good: 196n, scrap: 4n, startedAt: 0n, endedAt: 1n })).toBe(false);
    expect(slotOf({ label: "OEE", op: ">=", target: 85, unit: "%" } as never)).toBeNull();
    const ct = slotOf({ label: "Cycle time", op: "<=", target: 0.5, unit: "min" } as never)!;
    expect(holds(ct, { good: 10n, scrap: 0n, startedAt: 0n, endedAt: 300n })).toBe(true);
    expect(holds(ct, { good: 10n, scrap: 0n, startedAt: 0n, endedAt: 301n })).toBe(false);
  });
});
