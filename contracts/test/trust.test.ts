import { describe, expect, it } from "vitest";
import { decodeErrorResult, parseEther, type Abi, type Address, type Hex } from "viem";
import { artifact, chain } from "./chain.js";
import { ORDO_RELEASE, ORDO_SIGNATURE, PROOF_DOMAIN, trustDomain } from "./sigs.js";

const SITE = "site_pune1";
const ROLE = { OPERATOR: 1, SUPERVISOR: 2, VALIDATOR: 4, PLANT_MANAGER: 8, ADMIN: 16, VENDOR: 32, DEVICE: 64 } as const;
let nonce = 0;

async function setup() {
  const c = await chain();
  // account 4 relays everything and is Ordo's registrar
  const trust = await c.deploy("OrdoTrust", [parseEther("10"), 7 * 24 * 3600, c.accounts[4]]);
  // 0 admin/plant manager · 1 QE validator · 2 second validator · 3 process engineer · 4 relayer · 5 stranger · 6 treasury
  const acct = c.accounts;
  const sign = async (who: number, action: string, entity: string, site = SITE) => {
    const message = { action, entity, meaning: action, comment: "", site, nonce: `n${++nonce}`, issuedAt: new Date().toISOString() };
    const signature = await c.wallet(who).signTypedData({ domain: trustDomain(31337, trust.address), types: ORDO_SIGNATURE, primaryType: "OrdoSignature", message });
    return { ...message, signature };
  };
  const register = async (treasury = c.accounts[6]!, by = 0, relayer = 4) => write(relayer, "registerSite", [SITE, treasury, await sign(by, "site.register", `${SITE}#${treasury.toLowerCase()}`)]);
  const write = async (from: number, fn: string, args: unknown[], value?: bigint) => {
    const account = c.wallet(from).account;
    await c.pub.simulateContract({ account, address: trust.address, abi: trust.abi, functionName: fn, args, value } as never);
    const hash = await c.wallet(from).writeContract({ address: trust.address, abi: trust.abi, functionName: fn, args, value } as never);
    return c.pub.waitForTransactionReceipt({ hash: hash as Hex });
  };
  const read = <T>(fn: string, args: unknown[]) => c.pub.readContract({ address: trust.address, abi: trust.abi, functionName: fn, args }) as Promise<T>;
  const ent = (a: Address, role: keyof typeof ROLE) => `${a.toLowerCase()}#${role}`;
  const grant = async (who: number, role: keyof typeof ROLE, by = 0) => write(4, "grantRole", [SITE, acct[who], ROLE[role], await sign(by, "role.grant", ent(acct[who]!, role))]);
  return { ...c, trust, sign, write, read, ent, grant, acct, register };
}
type T = Awaited<ReturnType<typeof setup>>;

const ERR = artifact("OrdoTrust").abi as Abi;
function revertName(e: unknown): string {
  let cur: any = e;
  for (let i = 0; i < 8 && cur; i++) {
    const data = cur.data ?? cur.details?.match?.(/0x[0-9a-f]{8,}/i)?.[0];
    if (typeof data === "string" && /^0x[0-9a-f]{8,}$/i.test(data)) {
      try {
        return decodeErrorResult({ abi: ERR, data: data as Hex }).errorName;
      } catch {
        /* keep walking */
      }
    }
    cur = cur.cause;
  }
  return e instanceof Error ? e.message : String(e);
}
const reverts = async (p: Promise<unknown>, name: string) => {
  let got = "no revert";
  try {
    await p;
  } catch (e) {
    got = revertName(e);
  }
  expect(got).toBe(name);
};

/** Site registered by 0 (admin + plant manager); 1 and 2 are staked validators; 3 a process engineer. */
async function staffed(): Promise<T> {
  const t = await setup();
  await t.register();
  for (const v of [0, 1, 2]) await t.grant(v, "VALIDATOR");
  for (const v of [0, 1, 2]) await t.write(v, "stake", [SITE], parseEther("10"));
  return t;
}
const lotOf = (pkg: string, contentHash: Hex = `0x${"ab".repeat(32)}`, proofRoot: Hex = `0x${"cd".repeat(32)}`) => ({ siteId: SITE, lotLabel: "lot-so-1", packageId: pkg, runId: "run_1", contentHash, proofRoot });
type Lot = ReturnType<typeof lotOf>;
const releaseSig = async (t: T, who: number, lot: Lot, meaning: string, deadline = BigInt(Math.floor(Date.now() / 1000) + 86_400)) => {
  const message = { site: lot.siteId, packageId: lot.packageId, runId: lot.runId, lot: lot.lotLabel, meaning, statement: `${meaning} ${lot.packageId}`, comment: "", contentHash: lot.contentHash, proofRoot: lot.proofRoot, nonce: `r${++nonce}`, deadline };
  const signature = await t.wallet(who).signTypedData({ domain: PROOF_DOMAIN, types: ORDO_RELEASE, primaryType: "OrdoRelease", message });
  return { ...message, signature };
};
const releaseSigs = async (t: T, lot: Lot, who: [number, number, number]) => [
  await releaseSig(t, who[0], lot, "performed"),
  await releaseSig(t, who[1], lot, "reviewed"),
  await releaseSig(t, who[2], lot, "approved"),
];

describe("OrdoTrust: sites and role credentials", () => {
  it("registers a site from the admin's signature over the site and its treasury, sent by Ordo's registrar", async () => {
    const t = await setup();
    // nobody but the registrar can claim a site id, even with a valid admin signature
    await reverts(t.register(t.acct[6], 5, 5), "NotRegistrar");
    // the treasury is signed: a relayer cannot swap in its own quality fund
    await reverts(t.write(4, "registerSite", [SITE, t.acct[4], await t.sign(0, "site.register", `${SITE}#${t.acct[6]!.toLowerCase()}`)]), "WrongEntity");
    await t.register();
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[0], ROLE.ADMIN])).toBe(true);
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[0], ROLE.PLANT_MANAGER])).toBe(true);
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[4], ROLE.ADMIN])).toBe(false);
    expect((await t.read<readonly [boolean, Address]>("sites", [await t.read("siteKey", [SITE])]))[1]).toBe(t.acct[6]);
    await reverts(t.register(t.acct[6], 5), "SiteExists");
  });

  it("refuses a signature made for another deployment of OrdoTrust, so old grants cannot be replayed on a new one", async () => {
    const t = await setup();
    const other = await t.deploy("OrdoTrust", [parseEther("10"), 7 * 24 * 3600, t.accounts[4]]);
    const message = { action: "site.register", entity: `${SITE}#${t.acct[6]!.toLowerCase()}`, meaning: "", comment: "", site: SITE, nonce: "elsewhere", issuedAt: new Date().toISOString() };
    const signature = await t.wallet(0).signTypedData({ domain: trustDomain(31337, other.address), types: ORDO_SIGNATURE, primaryType: "OrdoSignature", message });
    await t.write(4, "registerSite", [SITE, t.acct[6], { ...message, signature }]);
    // the signer recovered here is not account 0, so it holds no role
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[0], ROLE.ADMIN])).toBe(false);
  });

  it("grants a role only with a site admin's signature for exactly that account and role", async () => {
    const t = await setup();
    await t.register();
    await t.grant(1, "OPERATOR");
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[1], ROLE.OPERATOR])).toBe(true);
    // a stranger cannot grant
    await reverts(t.write(4, "grantRole", [SITE, t.acct[2], ROLE.VALIDATOR, await t.sign(5, "role.grant", t.ent(t.acct[2]!, "VALIDATOR"))]), "NotAuthorized");
    // an admin signature for OPERATOR cannot be used for VALIDATOR
    await reverts(t.write(4, "grantRole", [SITE, t.acct[2], ROLE.VALIDATOR, await t.sign(0, "role.grant", t.ent(t.acct[2]!, "OPERATOR"))]), "WrongEntity");
    // nor replayed
    const sig = await t.sign(0, "role.grant", t.ent(t.acct[2]!, "SUPERVISOR"));
    await t.write(4, "grantRole", [SITE, t.acct[2], ROLE.SUPERVISOR, sig]);
    await reverts(t.write(4, "grantRole", [SITE, t.acct[2], ROLE.SUPERVISOR, sig]), "NonceUsed");
    // nor used at another site
    await reverts(t.write(4, "grantRole", [SITE, t.acct[2], ROLE.SUPERVISOR, await t.sign(0, "role.grant", t.ent(t.acct[2]!, "SUPERVISOR"), "site_other")]), "WrongSite");
    // revoke
    await t.write(4, "revokeRole", [SITE, t.acct[1], ROLE.OPERATOR, await t.sign(0, "role.revoke", t.ent(t.acct[1]!, "OPERATOR"))]);
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[1], ROLE.OPERATOR])).toBe(false);
  });
});

describe("OrdoTrust: validator staking", () => {
  it("only credentialed validators can stake; active needs the minimum and no pending unstake", async () => {
    const t = await setup();
    await t.register();
    await reverts(t.write(1, "stake", [SITE], parseEther("10")), "NotValidator");
    await t.grant(1, "VALIDATOR");
    await t.write(1, "stake", [SITE], parseEther("4"));
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[1]])).toBe(false);
    await t.write(1, "stake", [SITE], parseEther("6"));
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[1]])).toBe(true);
    await t.write(1, "requestUnstake", [SITE]);
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[1]])).toBe(false);
    await reverts(t.write(1, "withdraw", [SITE]), "StillLocked");
    await t.increaseTime(7 * 24 * 3600 + 1);
    const before = await t.pub.getBalance({ address: t.acct[1]! });
    await t.write(1, "withdraw", [SITE]);
    expect((await t.pub.getBalance({ address: t.acct[1]! })) - before).toBeGreaterThan(parseEther("9.99"));
  });

  it("after the cooldown anyone can pay a stake back, only to the validator (the call Hedera's scheduler makes)", async () => {
    const t = await setup();
    await t.register();
    await t.grant(1, "VALIDATOR");
    await t.write(1, "stake", [SITE], parseEther("10"));
    await reverts(t.write(4, "withdrawFor", [SITE, t.acct[1]]), "StillLocked");
    await t.write(1, "requestUnstake", [SITE]);
    await reverts(t.write(4, "withdrawFor", [SITE, t.acct[1]]), "StillLocked");
    await t.increaseTime(7 * 24 * 3600 + 1);
    const before = await t.pub.getBalance({ address: t.acct[1]! });
    await t.write(4, "withdrawFor", [SITE, t.acct[1]]);
    expect((await t.pub.getBalance({ address: t.acct[1]! })) - before).toBe(parseEther("10"));
    await reverts(t.write(4, "withdrawFor", [SITE, t.acct[1]]), "NothingStaked");
  });
});

describe("OrdoTrust: releases need staked validators", () => {
  it("records a release signed by a process engineer, a staked reviewer and a staked plant manager, once", async () => {
    const t = await staffed();
    await t.grant(3, "OPERATOR");
    const lot = lotOf("vp_1");
    const r = await t.write(4, "recordRelease", [lot, await releaseSigs(t, lot, [3, 1, 0])]);
    expect(r.status).toBe("success");
    const rel = await t.read<readonly [Hex, Hex, Address, Address, Address, bigint]>("releases", [await t.read("siteKey", [SITE]), await t.read("siteKey", ["vp_1"])]);
    expect(rel.slice(0, 4)).toEqual([lot.contentHash, lot.proofRoot, t.acct[3], t.acct[1]]);
    // the record cannot be overwritten with another hash
    const again = lotOf("vp_1", `0x${"ee".repeat(32)}`);
    await reverts(t.write(4, "recordRelease", [again, await releaseSigs(t, again, [3, 1, 0])]), "AlreadyReleased");
  });

  it("signatures cover the content, the proofs and the lot: none of them can be swapped by whoever relays", async () => {
    const t = await staffed();
    await t.grant(3, "OPERATOR");
    const lot = lotOf("vp_9");
    const sigs = await releaseSigs(t, lot, [3, 1, 0]);
    for (const swapped of [{ ...lot, contentHash: `0x${"11".repeat(32)}` }, { ...lot, proofRoot: `0x${"22".repeat(32)}` }, { ...lot, lotLabel: "lot-so-2" }, { ...lot, runId: "run_2" }])
      await reverts(t.write(4, "recordRelease", [swapped, sigs]), "WrongRelease");
    // a "reviewed" signature cannot stand in for "approved"
    await reverts(t.write(4, "recordRelease", [lot, [sigs[0], sigs[1], await releaseSig(t, 0, lot, "reviewed")]]), "WrongMeaning");
    // an expired signature is refused
    const late = [sigs[0], sigs[1], await releaseSig(t, 0, lot, "approved", 1n)];
    await reverts(t.write(4, "recordRelease", [lot, late]), "Expired");
  });

  it("rejects an unstaked reviewer, a reviewer who is unstaking, a non-manager approver and one person signing twice", async () => {
    const t = await staffed();
    const l = (p: string) => lotOf(p);
    // the performer is the package owner, whom Ordo checks; process engineers hold no OrdoTrust role
    await t.grant(5, "VALIDATOR"); // credential but no stake
    await reverts(t.write(4, "recordRelease", [l("vp_2"), await releaseSigs(t, l("vp_2"), [3, 5, 0])]), "NotAuthorized");
    await reverts(t.write(4, "recordRelease", [l("vp_3"), await releaseSigs(t, l("vp_3"), [3, 1, 2])]), "NotAuthorized");
    await reverts(t.write(4, "recordRelease", [l("vp_4"), await releaseSigs(t, l("vp_4"), [3, 0, 0])]), "DuplicateSigner");
    await t.write(1, "requestUnstake", [SITE]);
    await reverts(t.write(4, "recordRelease", [l("vp_5"), await releaseSigs(t, l("vp_5"), [3, 1, 0])]), "NotAuthorized");
  });
});

describe("OrdoTrust: slashing", () => {
  const slashSigs = async (t: T, validator: Address, amount: bigint, id: string, who: [number, number, number]) => {
    const e = `${validator.toLowerCase()}#${amount}#${id}`;
    return [await t.sign(who[0], "validator.slash", e), await t.sign(who[1], "validator.slash", e), await t.sign(who[2], "validator.slash", e)];
  };

  it("two other active validators and a plant manager slash a validator; the stake goes to the quality fund", async () => {
    const t = await staffed();
    await t.grant(3, "VALIDATOR");
    await t.write(3, "stake", [SITE], parseEther("10"));
    const fund = await t.pub.getBalance({ address: t.acct[6]! });
    await t.write(4, "slash", [SITE, t.acct[3], parseEther("4"), "slash_1", await slashSigs(t, t.acct[3]!, parseEther("4"), "slash_1", [1, 2, 0])]);
    expect((await t.pub.getBalance({ address: t.acct[6]! })) - fund).toBe(parseEther("4"));
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[3]])).toBe(false); // 6 left, below the minimum
  });

  it("refuses when the accused signs, a signer repeats, a signer is not a validator, or the amount exceeds the stake", async () => {
    const t = await staffed();
    const amt = parseEther("4");
    await reverts(t.write(4, "slash", [SITE, t.acct[1], amt, "s1", await slashSigs(t, t.acct[1]!, amt, "s1", [1, 2, 0])]), "NotAuthorized");
    await reverts(t.write(4, "slash", [SITE, t.acct[1], amt, "s2", await slashSigs(t, t.acct[1]!, amt, "s2", [2, 2, 0])]), "DuplicateSigner");
    await reverts(t.write(4, "slash", [SITE, t.acct[1], amt, "s3", await slashSigs(t, t.acct[1]!, amt, "s3", [2, 5, 0])]), "NotAuthorized");
    await t.grant(3, "VALIDATOR");
    await t.write(3, "stake", [SITE], parseEther("10"));
    await reverts(t.write(4, "slash", [SITE, t.acct[1], parseEther("11"), "s4", await slashSigs(t, t.acct[1]!, parseEther("11"), "s4", [2, 3, 0])]), "AmountTooHigh");
    // signatures for one amount cannot slash a larger amount
    const sigs = await slashSigs(t, t.acct[2]!, amt, "s5", [1, 3, 0]);
    await reverts(t.write(4, "slash", [SITE, t.acct[2], parseEther("9"), "s5", sigs]), "WrongEntity");
  });

  it("a validator who requested unstake can still be slashed during the cooldown", async () => {
    const t = await staffed();
    await t.grant(3, "VALIDATOR");
    await t.write(3, "stake", [SITE], parseEther("10"));
    await t.write(3, "requestUnstake", [SITE]);
    await t.write(4, "slash", [SITE, t.acct[3], parseEther("10"), "s6", await slashSigs(t, t.acct[3]!, parseEther("10"), "s6", [1, 2, 0])]);
    await t.increaseTime(7 * 24 * 3600 + 1);
    await reverts(t.write(3, "withdraw", [SITE]), "NothingStaked");
  });
});
