import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, keccak256, namehash, parseAbi, toBytes, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dnsEncode } from "../../src/chain/ensv2.js";
import { ORDO_ENS_ROLES_ABI, ORDO_ENS_ROLES_BYTECODE, ORDO_LOT_RESOLVER_ABI, ORDO_LOT_RESOLVER_BYTECODE } from "../../src/chain/ordo-ens-abi.js";
import { personLabel } from "../../src/core/names.js";
import { ANVIL_KEYS, anvilPath, deployer, startAnvil } from "../fixtures/anvil.js";
import { deployEnsV2 } from "../fixtures/ensv2.js";
import { boot, wallet, type Client, type System } from "./helpers.js";

/**
 * ENS as the access layer, end to end on the real ENSv2 contracts (anvil): people's member names are the role
 * credential OrdoEnsRoles reads, a released package is recorded on the lot's own ENS name only with signatures from
 * credentialed people, and the lot name resolves to its passport through Ordo's CCIP-Read gateway.
 */
const run = anvilPath() || process.env.CI ? describe : describe.skip;

const TEXT = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);
const ROLE = { OPERATOR: 1, SUPERVISOR: 2, VALIDATOR: 4, PLANT_MANAGER: 8, ADMIN: 16 };

run("ENS credentials and lot names", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let d: ReturnType<typeof deployer>;
  let stack: Awaited<ReturnType<typeof deployEnsV2>>;
  let roles: Address;
  let lots: Address;
  let admin: Client;
  let operator: Client;
  let qe: Client;
  let pm: Client;
  let site = "";
  let runId = "";
  const S = () => `/v1/sites/${site}`;
  const SITE = "pune-plant-1.ordo-test.eth";
  const LOT = `lot-so-7781.${SITE}`;
  const settle = async (n = 12) => {
    for (let i = 0; i < n; i++) {
      await sys.names.reconcile(10);
      await sys.lotNames.reconcile(10);
    }
  };
  const rolesOf = async (c: Client) =>
    Number(await d.pub.readContract({ address: roles, abi: ORDO_ENS_ROLES_ABI as Abi, functionName: "roles", args: [sitekey(site), c.address as Address] }));
  const resolve = (name: string, data: Hex) => d.pub.readContract({ address: lots, abi: ORDO_LOT_RESOLVER_ABI as Abi, functionName: "resolve", args: [dnsEncode(name), data] }) as Promise<Hex>;
  const textCall = (name: string, key: string) => encodeFunctionData({ abi: TEXT, functionName: "text", args: [namehash(name), key] });
  const onchainText = async (name: string, key: string) => decodeFunctionResult({ abi: TEXT, functionName: "text", data: await resolve(name, textCall(name, key)) }) as string;

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployEnsV2(anvil.url);
    d = deployer(anvil.url);
    roles = await d.deploy({ abi: ORDO_ENS_ROLES_ABI, bytecode: ORDO_ENS_ROLES_BYTECODE }, [stack.parentRegistry, "ordo-test.eth"]);
    lots = await d.deploy({ abi: ORDO_LOT_RESOLVER_ABI, bytecode: ORDO_LOT_RESOLVER_BYTECODE }, [roles, stack.resolver, d.account.address, ["https://ordo.example/v1/public/ens/{sender}/{data}.json"]]);
    ({ sys, app } = await boot({
      ENS_PARENT_NAME: "ordo-test.eth",
      ENS_REGISTRY_ADDRESS: stack.parentRegistry,
      ENS_RESOLVER_ADDRESS: stack.resolver,
      ENS_OWNER_KEY: ANVIL_KEYS[0]!,
      ENS_SEPOLIA_RPC_URL: anvil.url,
      ENS_CHAIN_ID: "31337",
      ENS_FACTORY_ADDRESS: stack.factory,
      ENS_USER_REGISTRY_IMPL: stack.userRegistryImpl,
      ENS_ROLES_ADDRESS: roles,
      ENS_LOT_RESOLVER_ADDRESS: lots,
      PUBLIC_URL: "https://ordo.example",
    }));
    admin = await wallet(app);
    operator = await wallet(app);
    qe = await wallet(app);
    pm = await wallet(app);
    site = (await admin.call("POST", "/v1/sites", { name: "Pune Plant 1", timezone: "Asia/Kolkata", lineName: "Line 2", zones: [] })).json.id;
    for (const [c, role] of [[operator, "operator"], [qe, "quality_engineer"], [pm, "plant_manager"]] as const) await admin.call("POST", `${S()}/team/invites`, { address: c.address, role });
    for (const [c, scope, fullName] of [[qe, "quality", "Meera Okafor"], [pm, "plant", "Sven Lindqvist"]] as const) {
      const id = (await c.call("POST", "/v1/onboarding", { siteId: site, kind: "validator", role: scope, form: { fullName, qualifications: "ISO 9001 lead auditor" } })).json.id;
      const typed = (await admin.call("POST", `${S()}/onboarding/${id}/sign-request`, { decision: "approve" })).json;
      await admin.call("POST", `${S()}/onboarding/${id}/decide`, { decision: "approve", comment: "", nonce: typed.message.nonce, signature: await admin.sign(typed) });
    }
  }, 120_000);
  afterAll(async () => {
    await sys?.close();
    anvil?.stop();
  });

  it("links the site, so contracts read people's roles from their member names", async () => {
    await settle();
    expect(await d.pub.readContract({ address: roles, abi: ORDO_ENS_ROLES_ABI as Abi, functionName: "siteLabel", args: [sitekey(site)] })).toBe("pune-plant-1");
    expect(await rolesOf(admin)).toBe(ROLE.ADMIN | ROLE.PLANT_MANAGER);
    expect(await rolesOf(operator)).toBe(ROLE.OPERATOR);
    expect(await rolesOf(qe)).toBe(ROLE.VALIDATOR); // quality engineers hold no on-chain role; the validator scope does
    expect(await rolesOf(pm)).toBe(ROLE.VALIDATOR | ROLE.PLANT_MANAGER);
    expect(await d.pub.readContract({ address: roles, abi: ORDO_ENS_ROLES_ABI as Abi, functionName: "memberName", args: [sitekey(site), qe.address as Address] })).toBe(`${personLabel(qe.address)}.${SITE}`);
    // the site's name now points at the lot resolver, which still answers the site's own records
    expect((await d.pub.readContract({ address: stack.parentRegistry, abi: parseAbi(["function getResolver(string) view returns (address)"]), functionName: "getResolver", args: ["pune-plant-1"] })).toLowerCase()).toBe(lots.toLowerCase());
    expect(await onchainText(SITE, "com.ordo.site")).toBe("Pune Plant 1");
    expect((await admin.call("GET", "/v1/status")).json.rails.find((r: any) => r.rail === "ens credentials")).toMatchObject({ live: true });
  }, 120_000);

  it("gives every lot a name that resolves to its passport through the gateway", async () => {
    const asset = (await admin.call("POST", `${S()}/assets`, { name: "CNC-01", kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: {}, idealCycleS: 30 })).json.id;
    const spec = {
      stages: [
        { code: "01", column: 1, name: "Release order", agent: "planning", resourceKind: "system", mode: "auto", escalationRole: "supervisor", timeoutMin: 10, criteria: [] },
        { code: "02", column: 2, name: "Machine housing", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "supervisor", timeoutMin: 60, criteria: [{ label: "Yield", op: ">=", target: 95, unit: "%" }] },
      ],
      rework: null,
    };
    await operator.call("POST", `${S()}/assets/${asset}/readings`, { signal: "execution", text: "ACTIVE" });
    await operator.call("POST", `${S()}/assets/${asset}/readings`, { signal: "part_count", value: 100 });
    const versionId = (await admin.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", description: "Test line", spec })).json.versionId;
    runId = (await admin.call("POST", `${S()}/runs`, { templateVersionId: versionId, orderRef: "SO-7781", quantity: 10 })).json.id;
    await operator.call("POST", `${S()}/assets/${asset}/readings`, { signal: "part_count", value: 110 });
    await sys.advance(true);
    await settle(2);

    const passport = (await admin.call("GET", `${S()}/runs/${runId}/passport`)).json;
    expect(passport.ens).toMatchObject({ name: LOT, releases: [] });
    expect((await app.request(`/v1/public/passports/${runId}`)).status).toBe(200);

    // a lot's records are off-chain: the resolver sends the client to Ordo's gateway (here viem follows the
    // OffchainLookup into the app), and accepts only an answer signed by Ordo's signer
    const seen: string[] = [];
    const ccip = createPublicClient({
      chain: foundry,
      transport: http(anvil.url),
      ccipRead: {
        request: async ({ data, sender, urls }) => {
          seen.push(urls[0]!);
          const res = await app.request(`/v1/public/ens/${sender}/${data}.json`);
          return ((await res.json()) as { data: Hex }).data;
        },
      },
    });
    const call = textCall(LOT, "url");
    const viaGateway = (await ccip.readContract({ address: lots, abi: ORDO_LOT_RESOLVER_ABI as Abi, functionName: "resolve", args: [dnsEncode(LOT), call] })) as Hex;
    expect(decodeFunctionResult({ abi: TEXT, functionName: "text", data: viaGateway })).toBe(`https://ordo.example/#/passport/${runId}`);
    expect(seen).toEqual(["https://ordo.example/v1/public/ens/{sender}/{data}.json"]);

    const sender = lots;
    const callData = encodeFunctionData({ abi: parseAbi(["function resolve(bytes,bytes)"]), functionName: "resolve", args: [dnsEncode(LOT), call] });
    const extraData = callData;
    const res = await app.request(`/v1/public/ens/${sender}/${callData}.json`);
    expect(res.status).toBe(200);
    const answer = ((await res.json()) as { data: Hex }).data;
    // POST works too, and an answer for another request is refused
    const posted = await app.request(`/v1/public/ens/${sender}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: callData, sender }) });
    expect(posted.status).toBe(200);
    const other = encodeFunctionData({ abi: parseAbi(["function resolve(bytes,bytes)"]), functionName: "resolve", args: [dnsEncode(LOT), textCall(LOT, "description")] });
    await expect(d.pub.readContract({ address: lots, abi: ORDO_LOT_RESOLVER_ABI as Abi, functionName: "resolveWithProof", args: [answer, other] })).rejects.toThrow();
    const desc = await sys.lotNames.answer(sender, other);
    expect(decodeFunctionResult({ abi: TEXT, functionName: "text", data: (await d.pub.readContract({ address: lots, abi: ORDO_LOT_RESOLVER_ABI as Abi, functionName: "resolveWithProof", args: [desc, other] })) as Hex })).toBe(
      "Lot SO-7781: 10 units of Housing v1, made at Pune Plant 1",
    );
    // only Ordo's resolver gets answers
    expect((await app.request(`/v1/public/ens/${"0x" + "1".repeat(40)}/${callData}.json`)).status).toBe(404);
  }, 120_000);

  it("records a release on the lot's name only with signatures from credentialed people", async () => {
    const created = await admin.call("POST", `${S()}/validation`, { type: "stage_validation", title: "Housing machining stage", objective: "Prove stage 02", acceptance: "Yield ≥ 95%", runId, stageCode: "02" });
    expect(created.status).toBe(200);
    const id = created.json.id;
    const p = (await admin.call("POST", `${S()}/validation/${id}/precheck`)).json;
    expect(p.checks[0].status).toBe("pass");
    for (const slot of p.evidence.filter((e: any) => !e.sha256)) {
      const form = new FormData();
      form.set("file", new File(["CMM report: all dimensions in tolerance"], "cmm.txt", { type: "text/plain" }));
      form.set("slotId", slot.id);
      await admin.upload(`${S()}/validation/${id}/evidence`, form);
    }
    const act = async (c: Client) => {
      const t = await c.call("POST", `${S()}/validation/${id}/sign-request`, { action: "sign", comment: "" });
      expect(t.status).toBe(200);
      return c.call("POST", `${S()}/validation/${id}/act`, { action: "sign", comment: "", nonce: t.json.message.nonce, signature: await c.sign(t.json) });
    };
    expect((await act(admin)).json.status).toBe("in_review");
    expect((await act(qe)).json.step).toBe("approval");
    expect((await act(pm)).json.status).toBe("released");
    await settle(4);

    const passport = (await admin.call("GET", `${S()}/runs/${runId}/passport`)).json;
    expect(passport.ens.releases).toEqual([expect.objectContaining({ packageId: id, status: "done", error: null })]);
    expect(await onchainText(LOT, "com.ordo.release")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await onchainText(LOT, "com.ordo.release.package")).toBe(id);
    expect(await onchainText(LOT, "com.ordo.release.signers")).toBe([admin, qe, pm].map((c) => `${personLabel(c.address)}.${SITE}`).join(","));
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    expect(decisions.some((x: any) => x.kind === "ens.lot_released")).toBe(true);

    // signatures from wallets without member names are refused by the contract itself
    const strangers = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
    const meanings = ["performed", "reviewed", "approved"];
    const sigs = await Promise.all(
      strangers.map(async (a, i) => {
        const message = { action: "validation.sign", entity: `vp_x#${meanings[i]}`, meaning: "x", comment: "", site, nonce: `n-${i}-${Date.now()}`, issuedAt: new Date().toISOString() };
        const signature = await a.signTypedData({ domain: { name: "Ordo", version: "1", chainId: 31337 }, types: { OrdoSignature: ["action", "entity", "meaning", "comment", "site", "nonce", "issuedAt"].map((name) => ({ name, type: "string" })) }, primaryType: "OrdoSignature", message });
        return { ...message, signature };
      }),
    );
    await expect(
      d.pub.simulateContract({ address: lots, abi: ORDO_LOT_RESOLVER_ABI as Abi, functionName: "recordRelease", args: [site, "lot-so-7781", "vp_x", `0x${"ab".repeat(32)}`, [31337n, 31337n, 31337n], sigs], account: d.account }),
    ).rejects.toThrow(/NotCredentialed/);
  }, 180_000);

  it("revoking a member name revokes the role everywhere", async () => {
    const qeId = (await admin.call("GET", `${S()}/team`)).json.members.find((m: any) => m.address === qe.address).userId;
    expect((await admin.call("DELETE", `${S()}/team/members/${qeId}/roles/quality_engineer`)).status).toBe(200);
    await settle();
    expect(await rolesOf(qe)).toBe(0);
    expect(await rolesOf(pm)).toBe(ROLE.VALIDATOR | ROLE.PLANT_MANAGER);
  }, 120_000);
});

const sitekey = (siteId: string) => keccak256(toBytes(siteId));
