# Ordo contracts and chain setup

| Contract | Purpose |
| --- | --- |
| `AgentSpendVault` | The Healer agent pays maintenance vendors only within on-chain limits: allow-listed vendors, per-payment cap, per-day cap, escrow released by a human (`RELEASER_ROLE`), refund after expiry, admin pause. Each payment carries the hash of the Ordo ledger entry that justified it. |
| `OrdoPolicyRegistry` | The plant manager publishes the hash and version of each line's autonomy policy. Ordo checks its local policy against it before trusting automation, and the Verify page shows the match. |

```bash
pnpm --filter @ordo/contracts test     # compile with npm solc + 8 tests on an in-process EVM
```

## Hedera testnet, step by step

You need a testnet account with an **ECDSA** key from [portal.hedera.com](https://portal.hedera.com) (about 100 testnet HBAR).

```bash
cd contracts
export HEDERA_OPERATOR_ID=0.0.xxxx HEDERA_OPERATOR_KEY=0x<ecdsa hex>

# 1. Accounts (operator, maintenance lead, plant manager, QE, agent, vendor) + HCS topics
pnpm bootstrap:hedera            # prints the .env lines for the server

# 2. Deploy AgentSpendVault + OrdoPolicyRegistry over JSON-RPC (Hashio, chain 296),
#    allow-list the vendor, fund the vault with 40 HBAR, publish the LINE-02 policy hash
pnpm deploy:hedera               # prints HEDERA_VAULT_ADDRESS and HEDERA_POLICY_REGISTRY_ADDRESS

# 3. Paste both outputs into server/.env, then check every rail live
cd ../server && pnpm smoke:hedera
```

Then start the server with `ANCHOR=hedera APPROVALS=hedera PAYMENTS=hedera`. Approvals become scheduled transactions on HashScan, anchors become HCS messages, and the work-order payment goes through the vault.

Verify contract source on Sourcify for chain 296 (HashScan shows verified source); `artifacts/*.json` has the ABI and bytecode.

Things to check on the day:

- Inside the EVM Hedera counts HBAR in tinybars (8 decimals); JSON-RPC `value` uses 18 decimals. Caps are set in tinybars by the deploy script.
- Deployments and testnet keys are written to `deployments/hedera-testnet.json`, which is git-ignored. Never reuse these keys on mainnet.

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
