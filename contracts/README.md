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

## ENS (Sepolia)

Register and wrap a parent name in the ENS app on Sepolia, take the Name Wrapper and Public Resolver addresses from the official ENS deployments list, then:

```bash
ENS_RPC_URL=... ENS_OWNER_KEY=0x... ENS_PARENT_NAME=ordo-mfg.eth \
ENS_NAME_WRAPPER=0x... ENS_PUBLIC_RESOLVER=0x... pnpm bootstrap:ens
```

It creates `line-02`, `cnc-04/05/07`, `healer` and `maintenance` subnames with `com.ordo.*` text records. Start the server with `IDENTITY=ens ENS_PARENT_NAME=... ENS_RPC_URL=...` and the console shows the names.

## 0G

```bash
pnpm --filter @ordo/server add @0glabs/0g-serving-broker @0gfoundation/0g-ts-sdk ethers
LLM_PROVIDER=0g EVIDENCE_STORE=0g ZG_PRIVATE_KEY=0x... pnpm --filter @ordo/server dev
```

Fund the wallet from the 0G faucet and deposit to the compute broker first. Package names change often; check docs.0g.ai.
