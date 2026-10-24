# Proof of work

How Ordo proves that a lot's stages really ran, that their counts came from where the work happened, that those counts meet each stage's criteria, and that the three people who released the lot signed exactly that. "Proof of work" here means evidence of manufacturing work, not mining.

## What each piece proves

| Claim | Who makes it | How it is checked |
| --- | --- | --- |
| A stage made N good and M scrap units between its start and end | The machine's **gateway**, with its own key (or the **operator**, for a manual stage) | An EIP-712 `OrdoReading` over `Poseidon(subject, good, scrap, startedAt, endedAt, salt)`. The counts stay private; the signature is public. |
| Those counts meet the stage's criteria (yield, scrap, defects ppm, cycle time) | Ordo's server, as prover | A Groth16 proof from `circuits/stage_check.circom`, over the same commitment. Anyone can verify it: the server, a buyer's browser, or `OrdoStageVerifier` on-chain. |
| An instrument measured a value for one bound of a stage's parameter (temperature stayed at least 35 °C, purity was at least 95 %) | The instrument's **gateway**, with its own key, from its own readings over the stage window | An EIP-712 `OrdoMeasurement` over `Poseidon(subject, value × 10⁴, salt)`, one per bound (`label`, and `label#max` for a range's upper bound). The value stays private. Ordo keeps the signed commitment only when the value is the one it measured itself (`matches`). |
| That value meets the bound | Ordo's server, as prover | A Groth16 proof from `circuits/spec_check.circom` over the signed commitment; over Ordo's own commitment when nobody signed (a manual asset, an operator's reading, counts). Anyone can verify it: the server, a buyer's browser, or `OrdoSpecVerifier` on-chain. |
| The signer is allowed to attest | The site, through ENS | The gateway owns a `member-<address>` name with `com.ordo.roles = device` (operators hold `operator`). `OrdoEnsRoles` reads it. |
| The lot was released as signed | Performed by, Reviewed by, Approved by | Each signs an `OrdoRelease` that names the site, package, run, lot, content hash and **proof root**. All three sign the same statement. |
| The release and the proofs agree | `OrdoLotResolver` (Sepolia) | At `recordRelease` it recovers every reading's and measurement's signer, checks their ENS role (device or operator), verifies every stage proof with `OrdoStageVerifier` and every source-signed parameter proof with `OrdoSpecVerifier`, and folds them: stages first, then parameters (`PARAM_LEAF`-marked leaves). The root it computes must equal the root the three signed. Parameters Ordo committed to itself are not in the root: no source stands behind them. |
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
- **Criteria the count circuit cannot prove** (OEE, measured signals, anything not derived from counts and time) keep their per-criterion spec proofs (`spec_check`): one Groth16 proof that a value meets its target without revealing it. A range or an envelope is two statements, one per bound; the upper bound is stored under `<label>#max` with its own salt, so the two proofs cannot be combined into the value. Values must be non-negative with at most four decimals.
- **Who commits to a measured value.** Where the stage's asset has a gateway, the gateway signs the commitment (`OrdoMeasurement`) from its own readings, and that commitment is what the proof opens and the release folds; the passport shows "value signed by the instrument's gateway" and re-checks the signature. If the gateway's value is not the one Ordo measured (`matches` false), Ordo keeps the signed row but proves its own commitment, as it does for manual assets, operator readings and counts; the passport says "value committed by Ordo", and such proofs stay off the chain. A gateway that lies about a value can only prove a lie it signed; securing the instrument is the plant's job, as with counts.
- **A new key re-proves everything.** Each `spec_proofs` row records the key it was proven for; after a new ceremony the server makes every proof again from the stored value and salt (`reconcile`). Commitments and ledger entries do not change.

## Trusted setup

- **Phase 1** is the PSE Perpetual Powers of Tau: 80 public contributions, `ppot_0080_13.ptau`, sha256 `ccee2808…930f`. Ordo did not make it.
- **Phase 2** is specific to each circuit, `stage_check` and `spec_check`, and the setup is sound if any one contributor destroyed their randomness. `scripts/zk-spec-setup.mjs` mirrors `zk-stage-setup.mjs` for the spec-check circuit and writes `server/zk/spec_check.ceremony.json`, served at `/v1/public/zk/spec-check`. Without a native `circom`, `CIRCOM` may point at a shim that runs `npx circom2`; the WebAssembly compiler needs circomlib's files copied in place of pnpm's symlinks.
- `server/zk/stage_check.ceremony.json` lists every step.

| Ceremony step | Status | How to do it |
| --- | --- | --- |
| First phase-2 contribution | Done (Ordo build) | `node scripts/zk-stage-setup.mjs setup` |
| One contribution from each person who should not have to trust the others | Needed before a demo or production | Each runs `node scripts/zk-stage-setup.mjs contribute "Name"`. The entropy is random and never written down. |
| Close with a public beacon | Needed before a demo or production | `node scripts/zk-stage-setup.mjs beacon <future block hash>` |
| Check the zkey | Anyone, at any time | `node scripts/zk-stage-setup.mjs verify`. It checks the zkey against the circuit and the public ptau. |

The same steps apply to `spec_check` with `scripts/zk-spec-setup.mjs` (first contribution done in the Ordo build; further contributions and the beacon are still needed). Each step regenerates the verifier contract (`src/OrdoStageVerifier.sol` or `src/OrdoSpecVerifier.sol`), so after the last one, deploy the verifiers and `OrdoLotResolver` again.

## Redeploying

This change alters the contracts' interfaces. Redeploy:

| What | Change | How to redeploy |
| --- | --- | --- |
| `OrdoTrust` | The constructor takes a registrar: only it may register a site. | `TRUST_REGISTRAR` defaults to the deployer; set it to the relayer's address. Run `deploy:trust`, then `setup:hedera contracts` for `OrdoWorkOrders` and `OrdoPolicies`, which point at it. |
| `OrdoEnsRoles`, `OrdoStageVerifier`, `OrdoLotResolver` | Device role and full-address member labels | `pnpm setup:ens-contracts` |
| `OrdoSpecVerifier`, `OrdoLotResolver` | The resolver takes the spec verifier and `recordRelease` takes a fourth argument, the parameter proofs; the spec-check key comes from the public ceremony | Done 24 Oct 2026 by the ENS setup workflow: `OrdoLotResolver` [`0x83bc…5795`](https://sepolia.etherscan.io/address/0x83bcae34de88b862f9641a408d926e1964b25795), `OrdoSpecVerifier` [`0xd4c4…ed17`](https://sepolia.etherscan.io/address/0xd4c4b8438c6519d6830668365068560e0239ed17); `ENS_ROLES_ADDRESS` and `ENS_LOT_RESOLVER_ADDRESS` set in Vercel. A later spec-check contribution regenerates `OrdoSpecVerifier` and needs the same run again. |

What else changes:

- OrdoTrust's `OrdoSignature` domain is now version 2, with `chainId` and `verifyingContract`. A signature for one deployment cannot be replayed on another.
- `OrdoWorkOrders`, `OrdoPolicies` and `OrdoAgentNFT` still use the version 1 domain.
- Release, reading and measurement statements use `{name: "Ordo", version: "2"}`, with no chain. They are statements about a lot, so the same signature is checked on Hedera and on Sepolia.
- Packages submitted before this change must be returned and signed again: their signatures are not release statements.
- Existing `member-<6 hex>` names are revoked and reissued as `member-<40 hex>`.
