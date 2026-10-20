import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, wallet, type Client, type System } from "./helpers.js";

/**
 * One person, one validator seat per site: validator applications carry a World ID proof bound to the
 * wallet, and a nullifier already held by another wallet at the site is refused. The Developer Portal is
 * faked: it accepts any proof whose `proof` field isn't "bad" and records what it was sent.
 */
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let admin: Client;
let site = "";
const S = () => `/v1/sites/${site}`;
const portal: { url: string; body: any }[] = [];
const fakePortal = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  portal.push({ url: String(url), body });
  const ok = body.responses[0].proof !== "bad";
  return new Response(JSON.stringify(ok ? { success: true } : { success: false, code: "invalid_proof", detail: "The proof is invalid" }), { status: ok ? 200 : 400 });
}) as typeof fetch;

/** What the IDKit widget hands back for a person (their nullifier) proving from a wallet. */
const proof = (person: string, signalWallet: string, p = "ok") => ({
  protocol_version: "4.0",
  nonce: "0x01",
  action: "ordo-validator",
  environment: "sandbox",
  responses: [{ identifier: "proof_of_human", signal_hash: hashSignal(signalWallet.toLowerCase()), proof: p, nullifier: person, issuer_schema_id: 1, expires_at_min: 0 }],
});
const apply = (c: Client, worldId?: unknown, role = "quality") => c.call("POST", "/v1/onboarding", { siteId: site, kind: "validator", role, form: { fullName: "V", qualifications: "CQE" }, worldId });
const approve = async (id: string) => {
  const typed = (await admin.call("POST", `${S()}/onboarding/${id}/sign-request`, { decision: "approve" })).json;
  return admin.call("POST", `${S()}/onboarding/${id}/decide`, { decision: "approve", comment: "", nonce: typed.message.nonce, signature: await admin.sign(typed) });
};

beforeAll(async () => {
  ({ sys, app } = await boot({ WORLD_ID_APP_ID: "app_staging_ordo", WORLD_ID_RP_ID: "rp_ordo", WORLD_ID_SIGNING_KEY: `0x${"11".repeat(32)}` }, { worldIdFetch: fakePortal }));
  admin = await wallet(app);
  site = (await admin.call("POST", "/v1/sites", { name: "Human Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
}, 60_000);
afterAll(async () => sys.close());

describe("World ID for validators", () => {
  it("hands the browser an RP-signed request bound to the wallet", async () => {
    expect((await admin.call("GET", "/v1/status")).json.worldId).toEqual({ appId: "app_staging_ordo", action: "ordo-validator", environment: "sandbox" });
    const r = (await admin.call("GET", "/v1/world-id/request")).json;
    expect(r.signal).toBe(admin.address);
    expect(r.rpContext.rp_id).toBe("rp_ordo");
    expect(r.rpContext.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("refuses a validator application without a proof, with another wallet's proof, or one the portal rejects", async () => {
    const a = await wallet(app);
    const b = await wallet(app);
    expect((await apply(a)).status).toBe(400);
    expect((await apply(a, proof("111", b.address))).json.error).toMatch(/different wallet/);
    expect((await apply(a, proof("111", a.address, "bad"))).json.error).toMatch(/did not accept/);
    // member applications don't need World ID
    expect((await a.call("POST", "/v1/onboarding", { siteId: site, kind: "member", role: "operator", form: { fullName: "Op" } })).status).toBe(200);
  });

  it("one person can't hold a second validator seat from another wallet", async () => {
    const w1 = await wallet(app);
    const w2 = await wallet(app);
    const r = await apply(w1, proof("222", w1.address));
    expect(r.status).toBe(200);
    expect(r.json.humanVerified).toBe(true);
    expect(portal.at(-1)!.url).toBe("https://developer.worldcoin.org/api/v4/verify/rp_ordo");
    // while the first application is pending
    expect((await apply(w2, proof("222", w2.address), "plant")).status).toBe(409);
    expect((await approve(r.json.id)).status).toBe(200);
    // and once it's approved
    const again = await apply(w2, proof("222", w2.address), "plant");
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/another wallet/);
    // a different person is fine
    expect((await apply(w2, proof("333", w2.address), "plant")).status).toBe(200);
    const v = (await admin.call("GET", `${S()}/validators`)).json.validators.find((x: any) => x.address === w1.address);
    expect(v.human).toBe(true);
    // the public ledger records a per-site reference, never the nullifier
    const decisions = JSON.stringify((await admin.call("GET", `${S()}/decisions?limit=200`)).json);
    expect(decisions).toContain("worldId");
    expect(decisions).not.toContain('"222"');
  });

  it("a validator approved without World ID can't sign until they verify", async () => {
    const w = await wallet(app);
    const id = (await apply(w, proof("444", w.address))).json.id;
    // simulate a validator approved before World ID was required
    await sys.db.query("UPDATE onboarding_requests SET world_id_nullifier = NULL WHERE id = $1", [id]);
    await approve(id);
    let me = (await w.call("GET", `${S()}/validators`)).json.me;
    expect(me.ok).toBe(false);
    expect(me.reason).toMatch(/World ID/);
    // someone else's nullifier is refused; their own binds the seat
    expect((await w.call("POST", `${S()}/validators/world-id`, { worldId: proof("222", w.address) })).status).toBe(409);
    expect((await w.call("POST", `${S()}/validators/world-id`, { worldId: proof("444", w.address) })).json.human).toBe(true);
    me = (await w.call("GET", `${S()}/validators`)).json.me;
    expect(me).toMatchObject({ ok: true, human: true });
  });
});
