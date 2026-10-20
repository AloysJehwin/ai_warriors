# Proof of work

How Ordo proves that a lot's stages really ran, that their counts came from where the work happened, that those counts meet each stage's criteria, and that the three people who released the lot signed exactly that. "Proof of work" here means evidence of manufacturing work, not mining.

## What each piece proves

| Claim | Who makes it | How it is checked |
| --- | --- | --- |
| A stage made N good and M scrap units between its start and end | The machine's **gateway**, with its own key (or the **operator**, for a manual stage) | An EIP-712 `OrdoReading` over `Poseidon(subject, good, scrap, startedAt, endedAt, salt)`. The counts stay private; the signature is public. |
| Those counts meet the stage's criteria (yield, scrap, defects ppm, cycle time) | Ordo's server, as prover | A Groth16 proof from `circuits/stage_check.circom`, over the same commitment. Anyone can verify it: the server, a buyer's browser, or `OrdoStageVerifier` on-chain. |
| The signer is allowed to attest | The site, through ENS | The gateway owns a `member-<address>` name with `com.ordo.roles = device` (operators hold `operator`). `OrdoEnsRoles` reads it. |
| The lot was released as signed | Performed by, Reviewed by, Approved by | Each signs an `OrdoRelease` that names the site, package, run, lot, content hash and **proof root**. All three sign the same statement. |
| The release and the proofs agree | `OrdoLotResolver` (Sepolia) | At `recordRelease` it recovers every reading's signer, checks their ENS role, verifies every stage proof and folds them. The root it computes must equal the root the three signed. |
| The record has not been rewritten | Ordo's ledger and HCS | Every reading, proof and signature is in the hash-chained ledger. Each reading names the newest HCS anchor its signer had seen, so it cannot predate it. |

## Flow

1. **Gateway.** An asset whose data source is `gateway` has a device address and no URL. The gateway (`pnpm --filter @ordo/server gateway`, `server/src/edge/gateway.ts`) runs next to the machine. It reads MTConnect, or simulates a machine for a demo, and pushes observations to `POST /v1/edge/observations`. Every request is signed with its key: `x-ordo-device`, `x-ordo-ts`, `x-ordo-nonce` and `x-ordo-sig`, an EIP-191 signature over `ordo-edge:<ts>:<nonce>:<METHOD>:<path>:<sha256(body)>`.
2. **Stage ends.** The engine records `workDoneAt`. A machine with a `scrap` counter owns its scrap count: Ordo takes scrap from the counter's change, not from a person.
3. **Reading.** The gateway polls `GET /v1/edge/stages`. For each finished stage on its machine, it counts good and scrap from its own counter history over `[startedAt, endedAt]`, commits, signs the `OrdoReading` and posts it to `POST /v1/edge/readings`. Ordo then:
   - recomputes the commitment;
   - recovers the signer;
   - checks the anchor;
   - flags `matches = false` when the signed counts differ from Ordo's own;
   - records `stage.reading_signed` in the ledger, with the commitment and no counts.

   For a manual stage, the operator ticks "Sign these counts" when recording, and the console has the wallet sign the same statement (`/runs/:runId/stages/:code/reading`).
4. **Proof.** Each engine cycle, `StageProofs` maps the stage's criteria to circuit slots: up to four per stage, kinds 1 to 5, targets ×10⁴. It checks the counts first, so a miss is reported as `not_met` with the criterion's name. Then it proves with Groth16.
5. **Release.** A validation package's owner signs Performed by. That fixes the release statement:
   - the lot's ENS label;
   - the content hash (checks and evidence);
   - the root of the proven stages: `root = keccak(root, keccak(subject, commitment, kinds, ops, targets, signer))`, starting from zero, stage by stage.

   The reviewer and approver sign the same statement. A signature over anything else is refused. The package cannot be submitted while a stage proof is still being generated.
6. **On-chain.** `OrdoTrust` (Hedera) records the release with its proof root. `OrdoLotResolver` (Sepolia) takes the three signatures and every stage proof, and verifies each one with `OrdoStageVerifier` before it records the release. `com.ordo.release.proofs` on the lot's name then reads `N stages proven, root 0x…`.
7. **Passport.** Each stage shows who signed its counts (the gateway's ENS name) and whether its proof verified. "Verify in this browser" recovers each reading's signer with viem and verifies each proof with snarkjs against `GET /v1/public/zk/stage-check`, so a buyer need not trust Ordo's server.

## Trust model and limits

- **Proven:** the counts the source signed meet the criteria. Nobody changed them afterwards, because the commitment is signed and in the ledger.
- **Not proven:** that the machine's counters are honest. A gateway signs what its controller reports. Securing the controller and the gateway's key is the plant's job; revoking the gateway's member name ends its authority everywhere.
- **Operator readings are weaker.** Ordo computes the operator's commitment, and the operator signs it. That attests "this person stood behind these counts", not machine data.
- **The prover sees the counts.** Ordo's server holds counts and salts to prove. They are never published. A plant that does not want even that can run the prover on the gateway: the circuit and keys are the same.
- **Replay.** Each gateway request is accepted once: the server remembers its nonce while its timestamp is fresh, ±2 minutes. That memory is per server instance.
- **Criteria the circuit cannot prove** (OEE, anything not derived from counts and time) keep their per-criterion spec proofs (`spec_check`).

## Trusted setup

- **Phase 1** is the PSE Perpetual Powers of Tau: 80 public contributions, `ppot_0080_13.ptau`, sha256 `ccee2808…930f`. Ordo did not make it.
- **Phase 2** is specific to `stage_check`. The setup is sound if any one contributor destroyed their randomness.
- `server/zk/stage_check.ceremony.json` lists every step.

| Ceremony step | Status | How to do it |
| --- | --- | --- |
| First phase-2 contribution | Done (Ordo build) | `node scripts/zk-stage-setup.mjs setup` |
| One contribution from each person who should not have to trust the others | Needed before a demo or production | Each runs `node scripts/zk-stage-setup.mjs contribute "Name"`. The entropy is random and never written down. |
| Close with a public beacon | Needed before a demo or production | `node scripts/zk-stage-setup.mjs beacon <future block hash>` |
| Check the zkey | Anyone, at any time | `node scripts/zk-stage-setup.mjs verify`. It checks the zkey against the circuit and the public ptau. |

Each step regenerates `src/OrdoStageVerifier.sol`, so after the last one, deploy the verifier and `OrdoLotResolver` again.

## Redeploying

This change alters the contracts' interfaces. Redeploy:

| What | Change | How to redeploy |
| --- | --- | --- |
| `OrdoTrust` | The constructor takes a registrar: only it may register a site. | `TRUST_REGISTRAR` defaults to the deployer; set it to the relayer's address. Run `deploy:trust`, then `setup:hedera contracts` for `OrdoWorkOrders` and `OrdoPolicies`, which point at it. |
| `OrdoEnsRoles`, `OrdoStageVerifier`, `OrdoLotResolver` | Device role and full-address member labels | `pnpm setup:ens-contracts` |

What else changes:

- OrdoTrust's `OrdoSignature` domain is now version 2, with `chainId` and `verifyingContract`. A signature for one deployment cannot be replayed on another.
- `OrdoWorkOrders`, `OrdoPolicies` and `OrdoAgentNFT` still use the version 1 domain.
- Release and reading statements use `{name: "Ordo", version: "2"}`, with no chain. They are statements about a lot, so the same signature is checked on Hedera and on Sepolia.
- Packages submitted before this change must be returned and signed again: their signatures are not release statements.
- Existing `member-<6 hex>` names are revoked and reissued as `member-<40 hex>`.
