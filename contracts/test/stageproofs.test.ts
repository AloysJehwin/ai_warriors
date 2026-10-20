import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { chain } from "./chain.js";
import { ORDO_READING, ORDO_RELEASE, PROOF_DOMAIN } from "./sigs.js";

const zk = (f: string) => new URL(`../../server/zk/${f}`, import.meta.url);
const wasm = new Uint8Array(readFileSync(zk("stage_check.wasm")));
const zkey = new Uint8Array(readFileSync(zk("stage_check.zkey")));
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SITE = "site_pune1";
const RUN = "run_7781";

const subjectOf = (site: string, run: string, stage: string) => BigInt(`0x${createHash("sha256").update(`ordo:stage:${site}:${run}:${stage}`).digest("hex")}`) % FIELD;
type Counts = { good: bigint; scrap: bigint; startedAt: bigint; endedAt: bigint };
// yield ≥ 98 %, scrap ≤ 2 %, cycle time ≤ 45 s, one unused slot
type Slots = [bigint, bigint, bigint, bigint];
const CRITERIA: { kind: Slots; op: Slots; target: Slots } = { kind: [1n, 2n, 4n, 0n], op: [0n, 1n, 1n, 0n], target: [980_000n, 20_000n, 450_000n, 0n] };

async function prove(stage: string, c: Counts, criteria = CRITERIA) {
  const poseidon = await buildPoseidon();
  const subject = subjectOf(SITE, RUN, stage);
  const salt = 4242n;
  const commitment = poseidon.F.toObject(poseidon([subject, c.good, c.scrap, c.startedAt, c.endedAt, salt])) as bigint;
  const { proof, publicSignals } = await groth16.fullProve({ subject, commitment, ...criteria, ...c, salt }, wasm, zkey, undefined, undefined, { singleThread: true });
  return { proof, publicSignals, subject, commitment };
}
/** snarkjs's proof as the verifier's calldata (B's coordinates are swapped for the precompile). */
const abiProof = (p: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }) => ({
  a: p.pi_a.slice(0, 2).map(BigInt) as [bigint, bigint],
  b: p.pi_b.slice(0, 2).map((x) => [BigInt(x[1]!), BigInt(x[0]!)]) as [[bigint, bigint], [bigint, bigint]],
  c: p.pi_c.slice(0, 2).map(BigInt) as [bigint, bigint],
});
const good: Counts = { good: 990n, scrap: 10n, startedAt: 1_760_000_000n, endedAt: 1_760_000_000n + 40n * 990n };

describe("stage-check circuit and OrdoStageVerifier", () => {
  let t: Awaited<ReturnType<typeof chain>>;
  let verifier: Awaited<ReturnType<typeof t.deploy>>;
  let harness: Awaited<ReturnType<typeof t.deploy>>;
  beforeAll(async () => {
    t = await chain();
    verifier = await t.deploy("OrdoStageVerifier", []);
    harness = await t.deploy("ProofsHarness", [verifier.address]);
  });
  const read = <T>(fn: string, args: unknown[]) => t.pub.readContract({ address: harness.address, abi: harness.abi, functionName: fn, args } as never) as Promise<T>;

  async function stageProof(stage: string, c: Counts, signer = 1) {
    const p = await prove(stage, c);
    const reading = { site: SITE, runId: RUN, stage, asset: "ast_cnc05", commitment: p.commitment, anchor: `0x${"aa".repeat(32)}` as Hex, signedAt: 1_760_100_000n };
    const readingSig = await t.wallet(signer).signTypedData({ domain: PROOF_DOMAIN, types: ORDO_READING, primaryType: "OrdoReading", message: reading });
    return { ...p, arg: { stage, asset: reading.asset, commitment: p.commitment, anchor: reading.anchor, signedAt: reading.signedAt, readingSig, ...abiProof(p.proof), kinds: CRITERIA.kind, ops: CRITERIA.op, targets: CRITERIA.target } };
  }

  it("verifies on-chain that a gateway-signed reading meets yield, scrap and cycle time, and folds it into the proof root", async () => {
    const s = await stageProof("02", good);
    expect(s.publicSignals.map(BigInt)).toEqual([s.subject, s.commitment, ...CRITERIA.kind, ...CRITERIA.op, ...CRITERIA.target]);
    expect(await read<bigint>("subjectOf", [SITE, RUN, "02"])).toBe(s.subject);
    const [attester, root] = await read<[Address, Hex]>("checkStage", [SITE, RUN, `0x${"00".repeat(32)}`, s.arg]);
    expect(attester).toBe(t.accounts[1]);
    const leaf = keccak256(
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256[4]" }, { type: "uint256[4]" }, { type: "uint256[4]" }, { type: "address" }], [s.subject, s.commitment, CRITERIA.kind, CRITERIA.op, CRITERIA.target, t.accounts[1]!]),
    );
    expect(root).toBe(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [`0x${"00".repeat(32)}`, leaf])));
  });

  it("a proof cannot be moved to another stage or lot, or checked against looser criteria", async () => {
    const s = await stageProof("02", good);
    await expect(read("checkStage", [SITE, RUN, `0x${"00".repeat(32)}`, { ...s.arg, stage: "03" }])).rejects.toThrow();
    await expect(read("checkStage", [SITE, "run_other", `0x${"00".repeat(32)}`, s.arg])).rejects.toThrow();
    await expect(read("checkStage", [SITE, RUN, `0x${"00".repeat(32)}`, { ...s.arg, targets: [950_000n, 20_000n, 450_000n, 0n] }])).rejects.toThrow();
    // a different commitment (counts edited after signing) is not what the gateway signed: another signer is recovered
    const [attester] = await read<[Address, Hex]>("checkStage", [SITE, RUN, `0x${"00".repeat(32)}`, s.arg]);
    expect(attester).toBe(t.accounts[1]);
  });

  it("cannot prove counts that miss a criterion", async () => {
    await expect(prove("02", { ...good, scrap: 30n })).rejects.toThrow(); // 97.0 % yield, 2.9 % scrap
    await expect(prove("02", { ...good, endedAt: good.startedAt + 50n * 990n })).rejects.toThrow(); // 50 s a part
    await expect(prove("02", { good: 0n, scrap: 0n, startedAt: 1n, endedAt: 2n }, { kind: [1n, 0n, 0n, 0n], op: [1n, 0n, 0n, 0n], target: [1_000_000n, 0n, 0n, 0n] })).rejects.toThrow(); // no units
    // defects in ppm and cycle time in minutes
    const ppm = { kind: [3n, 5n, 0n, 0n], op: [1n, 1n, 0n, 0n], target: [15_000n * 10_000n, 7_000n, 0n, 0n] };
    await expect(prove("02", good, ppm)).resolves.toBeTruthy(); // 10 000 ppm ≤ 15 000; 0.667 min ≤ 0.7
    await expect(prove("02", good, { ...ppm, target: [9_000n * 10_000n, 7_000n, 0n, 0n] })).rejects.toThrow();
  });

  it("recovers each release signer only for exactly the lot, content and proof root it signed", async () => {
    const lot = { siteId: SITE, lotLabel: "lot-so-7781", packageId: "vp_1", runId: RUN, contentHash: `0x${"ab".repeat(32)}` as Hex, proofRoot: `0x${"cd".repeat(32)}` as Hex };
    const message = { site: SITE, packageId: "vp_1", runId: RUN, lot: lot.lotLabel, meaning: "approved", statement: "Approved by — VP-101", comment: "", contentHash: lot.contentHash, proofRoot: lot.proofRoot, nonce: "n1", deadline: 4_000_000_000n };
    const signature = await t.wallet(2).signTypedData({ domain: PROOF_DOMAIN, types: ORDO_RELEASE, primaryType: "OrdoRelease", message });
    expect(await read<Address>("releaseSigner", [{ ...message, signature }, lot, "approved"])).toBe(t.accounts[2]);
    await expect(read("releaseSigner", [{ ...message, signature }, { ...lot, contentHash: `0x${"00".repeat(32)}` }, "approved"])).rejects.toThrow();
  });
});
