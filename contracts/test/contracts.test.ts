import { describe, expect, it } from "vitest";
import { decodeErrorResult, keccak256, parseEther, toBytes, type Abi, type Address, type Hex } from "viem";
import { artifact } from "./chain.js";
import { chain } from "./chain.js";

const H = (s: string) => keccak256(toBytes(s));

async function setup() {
  const c = await chain();
  const [admin, agent, releaser, vendor, stranger] = c.accounts as [Address, Address, Address, Address, Address];
  const vault = await c.deploy("AgentSpendVault", [admin, agent, releaser, { perTx: parseEther("5"), perDay: parseEther("8") }]);
  const write = (from: number, fn: string, args: unknown[] = [], value?: bigint) => send(c, from, vault.address, vault.abi, fn, args, value);
  const read = <T>(fn: string, args: unknown[] = []) => c.pub.readContract({ address: vault.address, abi: vault.abi, functionName: fn, args }) as Promise<T>;
  await c.wallet(0).sendTransaction({ to: vault.address, value: parseEther("50") });
  await write(0, "setVendor", [vendor, true]);
  return { ...c, vault, write, read, admin, agent, releaser, vendor, stranger };
}

/** Simulate first (decodes custom errors from eth_call), then send. */
async function send(c: Awaited<ReturnType<typeof chain>>, from: number, address: Address, abi: Abi, functionName: string, args: unknown[], value?: bigint) {
  const account = c.wallet(from).account;
  await c.pub.simulateContract({ account, address, abi, functionName, args, value } as never);
  const hash = await c.wallet(from).writeContract({ address, abi, functionName, args, value } as never);
  return c.pub.waitForTransactionReceipt({ hash: hash as Hex });
}

const ERR_ABI = [...artifact("AgentSpendVault").abi, ...artifact("OrdoPolicyRegistry").abi] as Abi;
/** Find raw revert data anywhere in the error chain and decode the custom error name. */
function revertName(e: unknown): string {
  let cur: any = e;
  for (let i = 0; i < 8 && cur; i++) {
    const data = cur.data ?? cur.details?.match?.(/0x[0-9a-f]{8,}/i)?.[0];
    if (typeof data === "string" && /^0x[0-9a-f]{8,}$/i.test(data)) {
      try {
        return decodeErrorResult({ abi: ERR_ABI, data: data as Hex }).errorName;
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

describe("AgentSpendVault", () => {
  it("agent pays an allow-listed vendor within caps and the event carries the incident hash", async () => {
    const t = await setup();
    const before = await t.pub.getBalance({ address: t.vendor });
    const r = await t.write(1, "pay", [t.vendor, parseEther("3"), H("INC-0001")]);
    expect(r.status).toBe("success");
    expect((await t.pub.getBalance({ address: t.vendor })) - before).toBe(parseEther("3"));
    expect(await t.read<bigint>("spentToday", [t.agent])).toBe(parseEther("3"));
    expect(r.logs.some((l) => (l.topics as Hex[]).includes(H("INC-0001")))).toBe(true);
  });

  it("enforces roles, allow-list, per-tx and per-day caps", async () => {
    const t = await setup();
    await reverts(t.write(4, "pay", [t.vendor, parseEther("1"), H("x")]), "AccessControlUnauthorizedAccount");
    await reverts(t.write(1, "pay", [t.stranger, parseEther("1"), H("x")]), "VendorNotAllowed");
    await reverts(t.write(1, "pay", [t.vendor, parseEther("6"), H("x")]), "OverPerTxCap");
    await reverts(t.write(1, "pay", [t.vendor, 0n, H("x")]), "ZeroAmount");
    await t.write(1, "pay", [t.vendor, parseEther("5"), H("a")]);
    await reverts(t.write(1, "pay", [t.vendor, parseEther("4"), H("b")]), "OverDailyCap");
    await t.increaseTime(24 * 3600);
    expect((await t.write(1, "pay", [t.vendor, parseEther("4"), H("c")])).status).toBe("success");
  });

  it("escrow → human release pays the vendor once", async () => {
    const t = await setup();
    const id = H("WO-1");
    await t.write(1, "escrow", [id, t.vendor, parseEther("4"), 3600n, H("INC-0002")]);
    expect(await t.read<bigint>("escrowedTotal")).toBe(parseEther("4"));
    await reverts(t.write(1, "release", [id]), "AccessControlUnauthorizedAccount");
    const before = await t.pub.getBalance({ address: t.vendor });
    await t.write(2, "release", [id]);
    expect((await t.pub.getBalance({ address: t.vendor })) - before).toBe(parseEther("4"));
    await reverts(t.write(2, "release", [id]), "NotEscrowed");
    await reverts(t.write(1, "escrow", [id, t.vendor, parseEther("1"), 3600n, H("x")]), "WorkOrderExists");
  });

  it("escrow refunds only after expiry and frees the balance", async () => {
    const t = await setup();
    const id = H("WO-2");
    await t.write(1, "escrow", [id, t.vendor, parseEther("4"), 600n, H("INC")]);
    await reverts(t.write(4, "refund", [id]), "NotExpired");
    await t.increaseTime(601);
    await t.write(4, "refund", [id]);
    expect(await t.read<bigint>("escrowedTotal")).toBe(0n);
    await reverts(t.write(2, "release", [id]), "NotEscrowed");
  });

  it("escrowed funds cannot be withdrawn or double-spent", async () => {
    const t = await setup();
    await t.write(1, "escrow", [H("WO-3"), t.vendor, parseEther("5"), 3600n, H("INC")]);
    const free = await t.read<bigint>("freeBalance");
    expect(free).toBe(parseEther("45"));
    await reverts(t.write(0, "withdraw", [t.admin, free + 1n]), "InsufficientFree");
    await t.write(0, "withdraw", [t.admin, free]);
    await reverts(t.write(1, "pay", [t.vendor, parseEther("1"), H("x")]), "InsufficientFree");
    await t.write(2, "release", [H("WO-3")]); // escrow still fully backed
  });

  it("pause stops agent and release, but refund still works", async () => {
    const t = await setup();
    await t.write(1, "escrow", [H("WO-4"), t.vendor, parseEther("1"), 60n, H("INC")]);
    await reverts(t.write(1, "pause"), "AccessControlUnauthorizedAccount");
    await t.write(0, "pause");
    await reverts(t.write(1, "pay", [t.vendor, parseEther("1"), H("x")]), "EnforcedPause");
    await reverts(t.write(2, "release", [H("WO-4")]), "EnforcedPause");
    await t.increaseTime(61);
    expect((await t.write(4, "refund", [H("WO-4")])).status).toBe("success");
  });

  it("a malicious vendor cannot re-enter release", async () => {
    const t = await setup();
    const evil = await t.deploy("ReentrantVendor", []);
    await t.write(0, "setVendor", [evil.address, true]);
    await t.write(0, "grantRole", [H("RELEASER_ROLE"), evil.address]);
    const id = H("WO-5");
    await t.write(1, "escrow", [id, evil.address, parseEther("2"), 3600n, H("INC")]);
    await t.write(1, "escrow", [H("WO-6"), evil.address, parseEther("2"), 3600n, H("INC")]);
    await send(t, 0, evil.address, evil.abi as Abi, "arm", [t.vault.address, H("WO-6")]);
    await t.write(2, "release", [id]);
    const reentered = await t.pub.readContract({ address: evil.address, abi: evil.abi as Abi, functionName: "reentered" });
    expect(reentered).toBe(false);
    expect(await t.read<bigint>("escrowedTotal")).toBe(parseEther("2"));
  });
});

describe("OrdoPolicyRegistry", () => {
  it("only the plant manager publishes; versions must increase; level must be 1..4", async () => {
    const c = await chain();
    const [admin, pm, stranger] = c.accounts as [Address, Address, Address];
    const reg = await c.deploy("OrdoPolicyRegistry", [admin, pm]);
    const write = (from: number, args: unknown[]) => send(c, from, reg.address, reg.abi, "setPolicy", args);
    const line = H("LINE-02");
    const hash = `0x${"ab".repeat(32)}` as Hex;
    await reverts(write(2, [line, 3, hash, 1]), "AccessControlUnauthorizedAccount");
    await reverts(write(1, [line, 5, hash, 1]), "InvalidLevel");
    await write(1, [line, 3, hash, 1]);
    await reverts(write(1, [line, 3, hash, 1]), "VersionNotIncreasing");
    const p = (await c.pub.readContract({ address: reg.address, abi: reg.abi, functionName: "policies", args: [line] })) as [number, Hex, number, bigint];
    expect(p[0]).toBe(3);
    expect(p[1]).toBe(hash);
    expect(p[2]).toBe(1);
    void stranger;
  });
});
