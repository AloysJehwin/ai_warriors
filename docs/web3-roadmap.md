# Web3 roadmap: roles, onboarding, staking, and the prize tracks

Written 19 Oct 2026, 17 days before ETHGlobal Mumbai (5–7 Nov). Mumbai's sponsor track rules are still "coming soon"; the shapes below come from ETHOnline 2026 (Sep 2026), the most recent event with the same sponsors. Re-check https://ethglobal.com/events/mumbai/prizes when rules land.

## What the sponsors reward right now

| Sponsor (Mumbai pool) | Recent track shape | What qualifies |
| --- | --- | --- |
| Hedera (USD 15k) | AI & Agentic Payments 6k (3 × 2k) · Tokenization of Anything 6k · Improve the Hedera Harness 2k · Continuity 1k | An agent that executes a payment on Hedera testnet with Hedera Agent Kit or x402; public repo; demo ≤ 5 min |
| 0G (USD 15k) | Best AI product on 0G | Inference on 0G Compute, data on 0G Storage, agents as ERC-7857 iNFTs |
| ENS (USD 10k) | Best Use of ENSv2 4.5k · Best Integration 0.5k (Continuity only) | Built on ENSv2 (Sepolia), with ENSv2 central to the product, not cosmetic |

Ordo is pre-existing work, so every track entered must also respect the Continuity rules (document what existed before the event).

## 1. Who can do what: roles become on-chain credentials

Today roles live in Postgres and are enforced by the server. For the hackathon, each role becomes a **non-transferable credential** that a contract can check, so "only a validator can validate" is enforced on-chain, not only in our API.

| Persona | Credential | Can | Earned by |
| --- | --- | --- | --- |
| Site admin | `ADMIN` | Approve onboarding, set policy | Creating the site |
| Operator | `OPERATOR` | Record units, hold a stage | Onboarding form + admin approval |
| Supervisor | `SUPERVISOR` | Start runs, release supervisor gates | Onboarding form + admin approval |
| **Validator** | `VALIDATOR` (+ scope: quality, process, plant) | Sign validation packages and quality gates | Onboarding form + qualification evidence + admin approval + **stake** |
| Maintenance vendor | `VENDOR` | Accept work orders, get paid by agents | Vendor form + **bond** |
| Agent | iNFT (ERC-7857) | Act within policy | Minted per agent with its policy hash and model id |
| Auditor / customer | none | Read and verify | Wallet only |

The existing roles map onto this: quality engineer, process engineer and plant manager become validator scopes; separation of duties (one signature per person per package) already exists in the server.

## 2. Onboarding flows ("entries")

Each flow is a form in the console, an admin review in the inbox, and an on-chain mint at approval. Every step writes to the ledger.

1. **Site onboarding.** Name, time zone, lines, zones (exists), plus an ENSv2 name for the site (`pune-plant-1.ordo.eth`) and the policy hash published to `OrdoPolicyRegistry`.
2. **Person onboarding.** Invite by wallet (exists) → the person fills a form: name, requested role, employee id, training certificates (files hashed, stored on 0G Storage) → admin approves in the inbox with an EIP-712 signature → credential minted and an ENS subname issued (`priya.pune-plant-1.ordo.eth`) with text records for role and site.
3. **Validator onboarding.** Person onboarding plus qualification evidence (for example an ISO 9001 auditor or GMP training certificate) and a **stake** of N HBAR into `ValidatorStaking`. Only an active, staked validator's EIP-712 signature counts in a validation package's chain.
4. **Vendor onboarding.** Company, wallet, service categories, hourly rate, response-time commitment, and a **bond**. Agents can only pay allow-listed vendors (`AgentSpendVault` already enforces this).
5. **Asset onboarding.** Register the machine (exists), give it an ENS subname (`cnc-05.pune-plant-1.ordo.eth`) with its limits and data source as text records, then run an **operational qualification** package. When validators release it, the asset joins its agent's pool, a flow the product docs already describe.
6. **Agent onboarding.** Each of the 8 agents is minted as an iNFT holding its scope, policy hash and model id; autonomy changes update it.

## 3. Staking, bonds and slashing

- **Why a stake.** A validator's signature releases product to customers. A stake makes a careless signature expensive, and turns "trust the QE" into "the QE has skin in the game", a strong judging story.
- **Mechanics** (`ValidatorStaking` on Hedera EVM): stake ≥ minimum to activate; unstaking has a 7-day cooldown so open disputes can still act; the stake is locked while the validator has a release inside its warranty window.
- **Slashing, carefully.** Only through a **recall package**: a new validation package that proves a released lot was defective, signed by two other validators and the plant manager. Slashed stake goes to a quality fund, not to the accusers, so nobody profits from a recall. Any automatic, agent-triggered slashing would be unfair and hard to defend to judges; avoid it.
- **Vendor bond.** A vendor that misses the response window on a work order loses a fixed share of its bond to the plant; one that delivers gets paid from the vault and its reputation record (on its ENS name) is updated.

## 4. The other web3 pieces worth building, ranked

| # | Implementation | Prize track | Why judges like it | Effort |
| --- | --- | --- | --- | --- |
| 1 | **HCS ledger anchoring live** (adapter exists) | Hedera | Every decision provable with HashScan links | S: needs a Hedera operator account |
| 2 | **Agents pay vendors** for work orders through Hedera Agent Kit, capped by `AgentSpendVault` | Hedera AI & Agentic Payments | This is the track's exact qualification | M |
| 3 | **Validator staking + role credentials** (sections 1–3) | Hedera; also strengthens every demo | "Only a staked validator can release product" on-chain | M |
| 4 | **Lot passport as an HTS NFT**: each production lot minted at run start, stage results and signatures appended, frozen when held, transferred to the customer on ship | Hedera Tokenization of Anything | Real regulation: the EU Digital Product Passport | M |
| 5 | **Public passport page**: a QR code on the shipped lot opens a page anyone can verify against HCS and the NFT | Hedera, ENS | Makes the proof tangible in a 5-minute demo | S |
| 6 | **ENSv2 names** for sites, people, assets and agents, with roles, limits and reputation as records; the console resolves names everywhere | ENS Best Use of ENSv2 | ENSv2 is central (identity and permissions), as the rules require | M |
| 7 | **0G Storage for evidence files** (Merkle root recorded in the ledger) and **0G Compute** for root-cause analysis | 0G | Verifiable AI and data, adapters partly exist | M |
| 8 | **Agents as iNFTs (ERC-7857)** with policy hash and model id | 0G | Agent identity and accountability | S–M |
| 9 | **x402 pay-per-call**: an agent buys an external inspection or data service per request | Hedera AI & Agentic Payments | Second qualifying payment path | M |
| 10 | **Threshold approvals**: autonomy L4 or a policy change needs 2-of-3 plant managers (Hedera threshold key or a Safe) | Hedera | Shows governance, not just logging | S–M |
| 11 | **Gasless smart wallets for the shop floor** (passkeys, sponsored gas) so operators never see a seed phrase | All | Adoption realism; strong UX point | M |
| 12 | **World ID** proof-of-personhood for signers (one human, one signer) | World (if Mumbai allows web apps) | Maps to 21 CFR Part 11 "unique signature" | M; may require a Mini App |
| 13 | **Chainlink** feeds machine data on-chain to settle vendor SLA disputes | Chainlink (5k, crowded) | Oracle use is real but secondary | M |

## 5. Recommended scope for the 17 days

Build in this order; stop at any line and still have a coherent demo.

1. Hedera operator account, HCS anchoring live, policy hash in `OrdoPolicyRegistry` (#1).
2. `OrdoRoles` credentials + `ValidatorStaking`, onboarding forms for people, validators and vendors, validator-only signatures checked on-chain (#3).
3. Agent pays the vendor for a work order through Agent Kit within the vault caps (#2).
4. Lot passport HTS NFT + public QR verify page (#4, #5).
5. ENSv2 names for site, people and assets with role and reputation records (#6).
6. 0G Storage for evidence and iNFT agents (#7, #8) if time remains.

That covers three sponsors with one coherent story: **a staked, named, accountable human signs; an accountable agent acts and pays within on-chain limits; every lot carries its proof to the customer.**

## 6. Demo script (5 minutes)

1. A validator onboards: fills the form, stakes HBAR, receives `priya.pune-plant-1.ordo.eth` with a validator credential.
2. A run starts; its lot is minted as a passport NFT.
3. A machine drifts; the agent opens a work order and pays the bonded vendor through Agent Kit, inside the vault cap.
4. The gate waits; an unstaked person's signature is rejected on-chain; Priya signs and the gate releases.
5. Scan the shipped lot's QR: the public page verifies the passport, the HCS trail and the validator's stake.

## 7. Testnets and what each one hosts

One ECDSA key can deploy on all three chains: its EVM address is derived from the key, so fund that address from each faucet. Keep each chain's key in its own GitHub environment; list the ones the app needs in `.github/vercel-secrets.map` and the **Sync secrets to Vercel** workflow copies them (names only in logs).

| Testnet | Chain id | Hosts | Items | Status | You provide |
| --- | --- | --- | --- | --- | --- |
| **Hedera testnet** | 296 | `OrdoTrust`; HCS ledger topic; agent and vendor accounts; `AgentSpendVault` + `OrdoPolicyRegistry`; lot passport HTS NFT collection; x402 settlement | #1 #2 #3 #4 #9 #10 | `OrdoTrust` live | Done: `hedera-testnet` environment. Later: an agent account (ECDSA) as `HEDERA_AGENT_ID` / `HEDERA_AGENT_KEY` |
| **Ethereum Sepolia** | 11155111 | ENSv2 parent name, subnames for site, people, assets and agents, text records | #6 | Not started | `sepolia` environment with `ENS_OWNER_KEY`; Sepolia ETH on its address. Confirm at the event that ENSv2 is still judged on Sepolia |
| **0G Galileo testnet** | check docs.0g.ai | 0G Storage for evidence files, 0G Compute for root-cause analysis, ERC-7857 agent iNFT contract | #7 #8 | Adapters partly exist | `zerog-testnet` environment with `ZG_PRIVATE_KEY`; 0G faucet tokens on its address |

Item #5 (public passport page) is a web route and needs no chain of its own.

## 8. Plan for the ten items

Each item lands as: a deploy workflow (like `deploy-trust.yml`) that prints only public values; public variables set in Vercel; secrets added to the map; tests on an in-process EVM or a mocked SDK; a demo step. Ordo is pre-existing work: record the baseline commit before 5 Nov and keep one visible, scoped item (suggested: #5 and the demo polish) for the event weekend.

| # | Item | Testnet | Build | Deploy and configure | Demo moment | Effort | When |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | HCS ledger anchoring live | Hedera | Adapter exists; add a workflow that creates the topic | `HEDERA_TOPIC_ID`, `ANCHOR=hedera`; operator id and key via the map | Proof page links each anchor to HashScan | 0.5 day | 20 Oct |
| 2 | Agents pay vendors (Agent Kit) | Hedera | Hedera Agent Kit tool behind the `open_work_order` action; vendor allow-list and caps from `AgentSpendVault`; payment written to the ledger | Run `bootstrap:hedera` and `deploy-hedera.ts` from a workflow; `HEDERA_AGENT_*`, `HEDERA_VENDOR_*`, `HEDERA_VAULT_ADDRESS`, `HEDERA_POLICY_REGISTRY_ADDRESS`, `PAYMENTS=hedera` | Drift opens a work order and the agent pays the bonded vendor inside the cap | 3 days | 21–23 Oct |
| 3 | Validator staking and role credentials | Hedera | Done | Done; needs `TRUST_RELAYER_KEY` in Vercel | An unstaked signature is rejected on-chain | Done | — |
| 4 | Lot passport HTS NFT | Hedera | Mint at run start (metadata = run, lot, template version); append stage results and signatures as HCS messages keyed to the serial; freeze on hold; transfer on ship | Workflow creates the NFT collection (supply, freeze and pause keys = operator); `HEDERA_PASSPORT_TOKEN_ID` | Run start mints serial #n; hold freezes it | 3 days | 24–27 Oct |
| 5 | Public passport page + QR | — | `#/passport/<token>/<serial>` without sign-in: verifies NFT state, the HCS trail and the releasing validators' stakes; QR on the run and release views | None | Scan the shipped lot's QR | 1 day | 28 Oct |
| 6 | ENSv2 names | Sepolia | Register the parent name; issue subnames at onboarding approval (people) and asset registration; role, site and reputation as text records; resolve names everywhere an address shows | Workflow runs `ens-bootstrap.ts`; `ENS_RPC_URL`, `ENS_PARENT_NAME`, `IDENTITY=ens`; `ENS_OWNER_KEY` via the map | The validator receives `priya.<site>.ordo…eth` on approval | 3 days | 29 Oct–1 Nov |
| 7 | 0G Storage and Compute | 0G | Evidence blobs uploaded to 0G Storage with the Merkle root in the ledger; root-cause analysis on 0G Compute with the provider's signed response stored | `ZG_RPC_URL`, `ZG_INDEXER_URL`, `ZG_PROVIDER_ADDRESS`; `ZG_PRIVATE_KEY` via the map; deposit to the compute ledger once | Evidence file shows its 0G root; diagnosis shows "verified on 0G Compute" | 2 days | 2–3 Nov |
| 8 | Agents as ERC-7857 iNFTs | 0G | Contract holding policy hash, model id and autonomy level; mint one per agent; autonomy changes update it | Workflow deploys it; `ZG_INFT_ADDRESS` | Agent page links to its iNFT | 1 day | 4 Nov |
| 9 | x402 pay-per-call | Hedera | An agent buys an external inspection report per request: Ordo hosts a paid `/v1/x402/inspection` endpoint and the agent pays it through an x402 facilitator | Facilitator URL; agent key reused. Confirm a Hedera testnet facilitator exists before building | Second payment path in the agent log | 2 days | Event weekend, if confirmed |
| 10 | Threshold approvals | Hedera | Raising autonomy to L4 or publishing a policy needs 2 of 3 plant manager signatures, checked by the contract against `OrdoTrust` roles | Redeploy `OrdoPolicyRegistry` with the threshold check | The third signature publishes the policy hash on-chain | 1.5 days | 24 Oct, alongside #4 |

**Priority if time runs short.** Must: #1, #2, #3, #4, #5 (Hedera Agentic Payments and Tokenization). Should: #6 (ENS), #10. Could: #7, #8 (0G), #9.

## Status

- **Done: roles, onboarding, validators, staking and slashing (#3).** `contracts/src/OrdoTrust.sol` keeps role credentials per site, granted only with a site admin's EIP-712 signature; validator stakes with a 7-day unstake cooldown; release records that require a staked reviewer and a staked plant manager; and slashing by two other active validators plus a plant manager into the site's quality fund. The contract verifies the same `OrdoSignature` typed data people sign in the console, so the relayer has no authority.
- **In the app:** applications to join a site (by site code), to become a validator, and to register as a vendor, with files hashed on upload; an Applications queue where admins approve or decline by signature; a Validators tab with stake, request-unstake and withdraw from the person's own wallet, and slash proposals; validation "Reviewed by" / "Approved by" and quality-gate releases accepted only from validators (and, with OrdoTrust configured, only from validators with an active stake); released packages recorded on-chain.
- **Tested:** 8 contract tests on an in-process EVM; an API test that deploys OrdoTrust and runs registration, signed grants, staking, an on-chain release and a slash; the browser flow with validator onboarding.
- **Deployed:** OrdoTrust is live on Hedera testnet at [`0x608cba52976e34fa160fe64ff0499a8a5a4eb9e1`](https://hashscan.io/testnet/contract/0x608cba52976e34fa160fe64ff0499a8a5a4eb9e1) (deploy tx [`0x4edba9c8…f676c6`](https://hashscan.io/testnet/transaction/0x4edba9c8ca3dd02922ba1c0e322ad6c2259359814de81f54f03f6a1b10f676c6)), minimum stake 10 HBAR, 7-day unstake cooldown. It was deployed by the `Deploy OrdoTrust` workflow (`.github/workflows/deploy-trust.yml`) from the `hedera-testnet` environment's operator key.
- **Done: agents pay vendors (#2) and threshold approvals (#10).** `OrdoWorkOrders` holds a fund per site; the maintenance agent escrows from its own account, within per-order and per-day caps an admin signed, only to holders of the site's `VENDOR` credential; a maintenance lead's signature releases the money; an unreleased escrow is refunded after 72 hours; an admin or plant manager can stop the agent. On Hedera the escrow is a Hedera Agent Kit tool (`ordo_escrow_work_order_tool`, `@hashgraph/hedera-agent-kit` v4), guarded by an Agent Kit policy that only allows work orders Ordo opened and audited to the ledger topic by Agent Kit's HCS hook. `OrdoPolicies` and the app require two plant managers to raise a line's autonomy and one to lower it. The old `AgentSpendVault`/`OrdoPolicyRegistry` pair is retired: the new contracts read credentials from `OrdoTrust` instead of their own allow-lists.
- **Deployed by the Hedera setup workflow:** ledger topic [`0.0.11087048`](https://hashscan.io/testnet/topic/0.0.11087048), `OrdoWorkOrders` [`0x6008…993f`](https://hashscan.io/testnet/contract/0x600807998f50258bc0319afab3411225c51a993f), `OrdoPolicies` [`0xfcde…bd43`](https://hashscan.io/testnet/contract/0xfcde36a4668c18c219ba1f3696bb0d68b9babd43), the lot passport collection [`0.0.11087232`](https://hashscan.io/testnet/token/0.0.11087232) and the maintenance agent's account [`0.0.11087374`](https://hashscan.io/testnet/account/0.0.11087374). The operator, relayer and agent keys are synced to Vercel, so production is configured for HCS anchoring (#1), on-chain credentials, agent payments and passport NFTs.
- **Done: lot passports (#4) and the public passport page (#5).** Every run gets a passport. With `HEDERA_PASSPORT_TOKEN_ID` set, the operator mints it as an HTS NFT whose metadata is the URL of the passport's HIP-412 JSON; the engine cycle updates the metadata when the lot is held, completed or shipped (HIP-657), so the NFT's history follows the lot on HashScan; a supervisor's signed shipment airdrops it to the customer (HIP-904, pending until claimed if the account is not associated). The QR code opens `#/passport/<run>`, which needs no account: product and quantity, every stage with its criteria, each signed decision by wallet address, validation releases with the signers' current stake and the on-chain release record, and the ledger re-walked with the anchor that covers the lot.
- **Done: x402 pay-per-call (#9).** Ordo sells a vibration assessment (ISO 10816-3 zone, trend, time to zone D) at `POST /v1/x402/vibration-assessment` for 0.1 HBAR a call over x402 v2 (`@x402/hedera` exact scheme, public facilitator `x402.org/facilitator`, which pays the fees). When the agent opens a work order it buys one with its own Hedera account through `@x402/fetch`, capped per call by x402 spend controls; the job queue retries a failed purchase, and the assessment, its HashScan payment link and a ledger decision show on the work order. A request that fails is never charged. `GET /v1/x402` lists the offer.
- **Done in code: ENSv2 names (#6).** The site gets `<site>.<parent>` with its own `UserRegistry`; each person a name in it minted to their wallet (empty role bitmap: not transferable, revoked by the site when they hold no role) with their roles, validator scope and signature count as text records; each asset and agent a name too. Names show in the team list and on the public passport. Tested on the real ENSv2 contracts (deployed on anvil in CI). **To go live:** create the `sepolia` GitHub environment with `ENS_OWNER_KEY` (an EVM key holding some Sepolia ETH), put a label in `.github/deploy/ens.request` and push.
- **Done in code: 0G Storage and Compute (#7).** With `EVIDENCE_STORE=0g`, each validation evidence file is copied to 0G Storage (encrypted with AES-256 under a key derived from Ordo's 0G key) by the job queue; the Merkle root and submission transaction go into the ledger and show on the evidence, and "verify" downloads the copy, decrypts it and checks it byte for byte. With `LLM_PROVIDER=0g`, diagnosis and recommendations run on 0G Compute through `@0gfoundation/0g-compute-ts-sdk`; each answer's chat id is checked against the provider's TEE signature (`processResponse`) and the decision records whether it verified. **To go live:** `ZG_PRIVATE_KEY` with 0G testnet tokens; compute also needs the ledger funded (3 0G minimum, more than the faucet's 0.1 per day: ask 0G at the event).
- **Next:** agents as ERC-7857 iNFTs (#8).
