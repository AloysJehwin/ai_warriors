# Ordo contracts and chain setup

Three contracts. Every authorisation in them is an Ordo EIP-712 signature (`OrdoSignature`, the typed data people sign in the console), so anyone can relay a transaction and the contract checks who signed, not who sent it.

| Contract | Purpose |
| --- | --- |
| `OrdoTrust` | Role credentials per site, granted with a site admin's signature; validator stakes with an unstake cooldown; release records that need a staked reviewer and a staked plant manager; slashing by two other validators plus a plant manager into the site's quality fund. |
| `OrdoWorkOrders` | The maintenance agent pays vendors within limits people set: a per-site fund, per-order and per-day caps an admin signs, escrow only to holders of the site's `VENDOR` credential, release on a supervisor's or plant manager's signature, refund after expiry, and a pause an admin or plant manager signs. |
| `OrdoPolicies` | Each line's autonomy level and policy hash. Raising autonomy or changing the policy needs two different plant managers' signatures; lowering needs one. |

`OrdoWorkOrders` and `OrdoPolicies` read credentials from the deployed `OrdoTrust` and share its signature scheme through `OrdoSigned`.

```bash
pnpm --filter @ordo/contracts test     # compile with npm solc + 16 tests on an in-process EVM
```

## Hedera testnet

Live on Hedera testnet:

| What | Where |
| --- | --- |
| `OrdoTrust` | [`0x608cba52976e34fa160fe64ff0499a8a5a4eb9e1`](https://hashscan.io/testnet/contract/0x608cba52976e34fa160fe64ff0499a8a5a4eb9e1) |
| `OrdoWorkOrders` | [`0x600807998f50258bc0319afab3411225c51a993f`](https://hashscan.io/testnet/contract/0x600807998f50258bc0319afab3411225c51a993f) |
| `OrdoPolicies` | [`0xfcde36a4668c18c219ba1f3696bb0d68b9babd43`](https://hashscan.io/testnet/contract/0xfcde36a4668c18c219ba1f3696bb0d68b9babd43) |
| Ledger topic (HCS) | [`0.0.11087048`](https://hashscan.io/testnet/topic/0.0.11087048) |
| Lot passport collection (HTS NFT) | [`0.0.11087232`](https://hashscan.io/testnet/token/0.0.11087232) |
| Maintenance agent account | [`0.0.11087374`](https://hashscan.io/testnet/account/0.0.11087374) · EVM `0x8af16bA6Bbae3DDA39acF028017e175390584db2` |

Deployments run in GitHub Actions with the operator account held in the `hedera-testnet` environment (`HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, an **ECDSA** key):

- **Deploy OrdoTrust** (`.github/workflows/deploy-trust.yml`): push a change to `.github/deploy/trust.request`.
- **Hedera setup** (`.github/workflows/hedera-setup.yml`): list what to create in `.github/deploy/hedera.request` and push it:
  - `topic` creates the HCS topic the ledger is anchored to (`HEDERA_TOPIC_ID`),
  - `contracts` deploys `OrdoWorkOrders` and `OrdoPolicies` against `OrdoTrust` (`TRUST_WORKORDERS_ADDRESS`, `TRUST_POLICIES_ADDRESS`),
  - `passport` creates the HTS NFT collection for lot passports (`HEDERA_PASSPORT_TOKEN_ID`); the operator is treasury, supply and metadata key,
  - `agent` creates the maintenance agent's own account with 20 HBAR (`HEDERA_AGENT_ID`); its key goes straight to Vercel and is never printed, so this one needs `VERCEL_TOKEN` as a repository secret.

The logs print only public values. The same scripts run locally:

```bash
cd contracts
export HEDERA_OPERATOR_ID=0.0.xxxx HEDERA_OPERATOR_KEY=0x<ecdsa hex>
pnpm deploy:trust
pnpm setup:hedera topic
TRUST_CONTRACT_ADDRESS=0x… pnpm setup:hedera contracts
SECRET_OUT=agent.env pnpm setup:hedera agent
cd ../server && pnpm smoke:hedera      # posts an anchor to the topic and verifies it on the mirror node
```

Then, in Ordo: register the site on-chain (Team & validators → Validators), sign the agent's caps and add funds (Work orders), and onboard vendors. When the agent's work order is approved, or it acts on its own at L4, it escrows through Hedera Agent Kit; a maintenance lead's signature pays the vendor.

Things to check on the day:

- Inside the EVM Hedera counts HBAR in tinybars (8 decimals); JSON-RPC `value` uses 18 decimals. Caps and amounts in the contracts are tinybars.
- The agent account is created with an ECDSA alias, so its EVM address (the one the caps are signed for) is derived from its key.
- Verify contract source on Sourcify for chain 296 so HashScan shows it; `artifacts/*.json` has the ABI and bytecode.

## Proof of work

Post the current commit to the HCS build topic every few hours:

```bash
cd server && HEDERA_BUILD_TOPIC_ID=<build topic> pnpm anchor:build
```

## ENS (Sepolia, ENSv2)

ENSv2 gives every name its own registry. `scripts/ens-setup.ts` registers Ordo's parent name once: it deploys Ordo's `PermissionedResolver` and a `UserRegistry` through ENS's `VerifiableFactory`, then registers `<label>.eth` (commit, wait, pay in the testnet's MockUSDC) pointing at both. Run it from the **ENS setup** workflow (put the label in `.github/deploy/ens.request`; needs the `sepolia` environment with `ENS_OWNER_KEY` holding some Sepolia ETH), or locally:

```bash
ENS_OWNER_KEY=0x... ENS_LABEL=ordo-mfg pnpm setup:ens
```

**Live:** [`ordo-mfg.eth`](https://sepolia.app.ens.domains/ordo-mfg.eth), registry `0x1F621f14718a9251b74F1683D6F1D5F8E9889358`, resolver `0xC2992b48350F642cd820a22DAf5ffaDB6e26566C`, owner `0x38e6C7622b2E9BdcB16821E88083274489625b74`.

The app then issues the rest as the site changes: `<site>.<parent>` with its own `UserRegistry`, and in it a name for each person (minted to their wallet with no roles on the token, so it cannot be transferred; revoked when they hold no role), each asset and each agent, with `com.ordo.*` text records in Ordo's resolver. The contract addresses are the Sepolia set ENS deployed on 2026-10-01 (`server/src/chain/ensv2.ts`).

## 0G (Galileo testnet, chain 16602)

`src/OrdoAgentNFT.sol` makes each agent of each site an ERC-7857 iNFT: its intelligent data is the policy hash it acts under, its model, the autonomy each line gives it and its scope; Ordo updates it when any of those change (`Updated` events), and the site's plant managers are its authorized users. Agents belong to their site, so tokens do not transfer. It uses OpenZeppelin's ERC-721, which needs Cancun, so `compile.mjs` compiles it in a separate Cancun pass (0G supports Cancun) and its tests run on anvil.

**Live:** `OrdoAgentNFT` `0x9577498d6305a8498744ab33217fab6722ff8141` on 0G Galileo, minter `0xa902C5542Fc209e639Ed151a3619e103D18bD55a`.

The **0G setup** workflow (`.github/deploy/zerog.request`; `key` generates Ordo's 0G key and keeps it in Vercel) deploys it (`inft`), turns on evidence copies to 0G Storage (`storage`) and funds the 0G Compute ledger (`ledger`), and writes the values and the key to Vercel. Locally:

```bash
ZG_PRIVATE_KEY=0x... pnpm setup:zerog                          # deploy OrdoAgentNFT → ZG_INFT_ADDRESS
ZG_PRIVATE_KEY=0x... pnpm --filter @ordo/server zerog:ledger   # fund 0G Compute (3 0G), list providers
```
