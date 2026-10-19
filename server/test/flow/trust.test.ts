import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, parseEther, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORDO_TRUST_ABI, ORDO_TRUST_BYTECODE } from "../../src/chain/ordo-trust-abi.js";
import { boot, wallet, type Client, type System } from "./helpers.js";

/**
 * The trust layer end to end against a real EVM (in-process): OrdoTrust deployed, Ordo relaying
 * signed grants, a validator staking from their own wallet, a release recorded on-chain, a slash.
 */
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let contract: Hex;
let pub: ReturnType<typeof createPublicClient>;
const keys = { admin: generatePrivateKey(), qe: generatePrivateKey(), v2: generatePrivateKey(), pe: generatePrivateKey() };
const people: Record<keyof typeof keys, Client> = {} as never;
let site = "";
const S = () => `/v1/sites/${site}`;
let transport: ReturnType<typeof custom>;

beforeAll(async () => {
  const funder = generatePrivateKey();
  const relayer = generatePrivateKey();
  const provider = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", chainId: 31337 },
    wallet: { accounts: [funder, relayer, ...Object.values(keys)].map((secretKey) => ({ secretKey, balance: toHex(parseEther("1000")) })) },
  });
  transport = custom(provider as never);
  pub = createPublicClient({ chain: foundry, transport });
  const deployer = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(funder) });
  const hash = await deployer.deployContract({ abi: ORDO_TRUST_ABI, bytecode: ORDO_TRUST_BYTECODE, args: [parseEther("10"), 7n * 24n * 3600n] } as never);
  contract = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  ({ sys, app } = await boot({ TRUST_CONTRACT_ADDRESS: contract, TRUST_RELAYER_KEY: relayer, TRUST_CHAIN_ID: "31337", TRUST_DECIMALS: "18", TRUST_SYMBOL: "ETH" }, { trustTransport: transport }));
  for (const k of Object.keys(keys) as (keyof typeof keys)[]) people[k] = await wallet(app, keys[k]);
}, 120_000);
afterAll(async () => sys.close());

const stake = async (who: keyof typeof keys, amount: string) => {
  const w = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(keys[who]) });
  const h = await w.writeContract({ address: contract, abi: ORDO_TRUST_ABI, functionName: "stake", args: [site], value: parseEther(amount) } as never);
  return pub.waitForTransactionReceipt({ hash: h });
};
const read = <T>(fn: string, args: unknown[]) => pub.readContract({ address: contract, abi: ORDO_TRUST_ABI, functionName: fn, args } as never) as Promise<T>;

describe("on-chain trust", () => {
  it("registers the site in OrdoTrust with the admin's signature", async () => {
    site = (await people.admin.call("POST", "/v1/sites", { name: "Chain Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
    expect((await people.admin.call("GET", `${S()}/chain`)).json.registered).toBe(false);
    const typed = (await people.admin.call("POST", `${S()}/chain/register/sign-request`)).json;
    expect(typed.domain.chainId).toBe(31337);
    const r = await people.admin.call("POST", `${S()}/chain/register`, { nonce: typed.message.nonce, signature: await people.admin.sign(typed) });
    expect(r.status).toBe(200);
    expect(r.json.registered).toBe(true);
    expect(await read<boolean>("hasRole", [site, people.admin.account.address, 16])).toBe(true);
  });

  it("an approved validator onboarding is relayed as an on-chain credential; staking activates it", async () => {
    for (const [who, scope, name] of [["qe", "quality", "Meera"], ["v2", "process", "Arjun"]] as const) {
      const id = (await people[who].call("POST", "/v1/onboarding", { siteId: site, kind: "validator", role: scope, form: { fullName: name, qualifications: "GMP auditor" } })).json.id;
      const typed = (await people.admin.call("POST", `${S()}/onboarding/${id}/sign-request`, { decision: "approve" })).json;
      const r = await people.admin.call("POST", `${S()}/onboarding/${id}/decide`, { decision: "approve", comment: "", nonce: typed.message.nonce, signature: await people.admin.sign(typed) });
      expect(r.json.chain.status).toBe("done");
      expect(await read<boolean>("hasRole", [site, people[who].account.address, 4])).toBe(true);
    }
    // credentialed but not staked: not an active validator
    let me = (await people.qe.call("GET", `${S()}/validators`)).json.me;
    expect(me.ok).toBe(false);
    expect(me.reason).toMatch(/stake/);
    await stake("qe", "10");
    await stake("v2", "10");
    me = (await people.qe.call("GET", `${S()}/validators`)).json.me;
    expect(me.ok).toBe(true);
    const list = (await people.admin.call("GET", `${S()}/validators`)).json.validators;
    expect(list.find((v: any) => v.address === people.qe.address).onchain.stake).toBe(parseEther("10").toString());
  });

  it("a release is recorded on-chain only with staked validators' signatures", async () => {
    // the admin is the site's plant manager; to approve releases they must also be a staked validator
    const id = (await people.admin.call("POST", "/v1/onboarding", { siteId: site, kind: "validator", role: "plant", form: { fullName: "Admin", qualifications: "Plant manager" } })).json.id;
    const typed0 = (await people.admin.call("POST", `${S()}/onboarding/${id}/sign-request`, { decision: "approve" })).json;
    await people.admin.call("POST", `${S()}/onboarding/${id}/decide`, { decision: "approve", comment: "", nonce: typed0.message.nonce, signature: await people.admin.sign(typed0) });
    await stake("admin", "10");
    // the process engineer joins as a member
    const peReq = (await people.pe.call("POST", "/v1/onboarding", { siteId: site, kind: "member", role: "process_engineer", form: { fullName: "Priya" } })).json.id;
    const t1 = (await people.admin.call("POST", `${S()}/onboarding/${peReq}/sign-request`, { decision: "approve" })).json;
    const peDone = await people.admin.call("POST", `${S()}/onboarding/${peReq}/decide`, { decision: "approve", comment: "", nonce: t1.message.nonce, signature: await people.admin.sign(t1) });
    expect(peDone.json.chain).toBeNull(); // process engineer has no on-chain role

    const pkg = (await people.pe.call("POST", `${S()}/validation`, { type: "process_change", title: "Coolant change", objective: "x", acceptance: "y" })).json;
    await people.pe.call("POST", `${S()}/validation/${pkg.id}/checks`, { criterion: "Surface finish", method: "Profilometer", target: "Ra ≤ 0.8" });
    const chk = (await people.pe.call("GET", `${S()}/validation/${pkg.id}`)).json.checks[0];
    await people.pe.call("PATCH", `${S()}/validation/${pkg.id}/checks/${chk.id}`, { status: "pass", result: "Ra 0.6" });
    await people.pe.call("POST", `${S()}/validation/${pkg.id}/precheck`);
    for (const e of (await people.pe.call("GET", `${S()}/validation/${pkg.id}`)).json.evidence.filter((x: any) => x.required)) {
      const f = new FormData();
      f.set("file", new File([`evidence ${e.name}`], `${e.name}.txt`, { type: "text/plain" }));
      f.set("slotId", e.id);
      await people.pe.upload(`${S()}/validation/${pkg.id}/evidence`, f);
    }
    const act = async (c: Client) => {
      const t = await c.call("POST", `${S()}/validation/${pkg.id}/sign-request`, { action: "sign", comment: "" });
      if (t.status !== 200) return t;
      expect(t.json.domain.chainId).toBe(31337);
      return c.call("POST", `${S()}/validation/${pkg.id}/act`, { action: "sign", comment: "", nonce: t.json.message.nonce, signature: await c.sign(t.json) });
    };
    expect((await act(people.pe)).json.step).toBe("qe_review");
    expect((await act(people.qe)).json.step).toBe("approval");
    const done = await act(people.admin);
    expect(done.json.status).toBe("released");
    expect(done.json.onchain.status).toBe("done");
    const rel = await read<readonly unknown[]>("releases", [await read("siteKey", [site]), await read("siteKey", [pkg.id])]);
    expect((rel[2] as string).toLowerCase()).toBe(people.qe.address);
  });

  it("two validators and a plant manager slash a validator; the accused cannot sign", async () => {
    const qe = (await people.admin.call("GET", `${S()}/validators`)).json.validators.find((v: any) => v.address === people.qe.address);
    const p = await people.admin.call("POST", `${S()}/slash`, { validatorUserId: qe.userId, amount: parseEther("3").toString(), reason: "Released lot L-1 later recalled for porosity" });
    expect(p.status).toBe(200);
    const sign = async (c: Client) => {
      const t = await c.call("POST", `${S()}/slash/${p.json.id}/sign-request`);
      if (t.status !== 200) return t;
      return c.call("POST", `${S()}/slash/${p.json.id}/sign`, { nonce: t.json.message.nonce, signature: await c.sign(t.json) });
    };
    expect((await sign(people.qe)).status).toBe(403);
    // v2 signs as a validator, admin as plant manager; a third distinct voice is needed: the admin is
    // also a validator, but cannot sign twice, so the proposal waits
    expect((await sign(people.v2)).status).toBe(200);
    expect((await sign(people.admin)).status).toBe(200);
    let prop = (await people.admin.call("GET", `${S()}/validators`)).json.proposals[0];
    expect(prop.status).toBe("open");
    expect(prop.signatures.map((s: any) => s.capacity).sort()).toEqual(["plant_manager", "validator"]);
    // a second validator joins and signs: the slash executes on-chain
    const k = generatePrivateKey();
    const fund = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(keys.v2) });
    await pub.waitForTransactionReceipt({ hash: await fund.sendTransaction({ to: privateKeyToAccount(k).address, value: parseEther("20") }) });
    keys.pe = k; // reuse the stake helper slot
    const third = await wallet(app, k);
    const id = (await third.call("POST", "/v1/onboarding", { siteId: site, kind: "validator", role: "quality", form: { fullName: "Lena", qualifications: "QA" } })).json.id;
    const t = (await people.admin.call("POST", `${S()}/onboarding/${id}/sign-request`, { decision: "approve" })).json;
    await people.admin.call("POST", `${S()}/onboarding/${id}/decide`, { decision: "approve", comment: "", nonce: t.message.nonce, signature: await people.admin.sign(t) });
    await stake("pe", "10");
    expect((await sign(third)).status).toBe(200);
    prop = (await people.admin.call("GET", `${S()}/validators`)).json.proposals[0];
    expect(prop.status).toBe("executed");
    expect(prop.chain.status).toBe("done");
    const st = await read<readonly [bigint, bigint]>("stakes", [await read("siteKey", [site]), people.qe.address]);
    expect(st[0]).toBe(parseEther("7"));
  });
});
