/**
 * Live check of every Hedera adapter against testnet. Run on a machine with internet access:
 *   cd server && node --env-file=.env --import tsx scripts/smoke-hedera.ts
 * Prints HashScan links for each step. Uses ~1 HBAR of testnet funds.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { hederaFromConfig } from "../src/chain/hedera.js";
import { loadPolicy } from "../src/domain/policy.js";

const cfg = loadConfig();
const h = hederaFromConfig(cfg);
const step = async (name: string, f: () => Promise<unknown>) => {
  try {
    console.log(`✔ ${name}`, await f());
  } catch (e) {
    console.log(`✘ ${name}:`, e instanceof Error ? e.message : e);
  }
};

const entryHash = `sha256:${"ab".repeat(32)}`;
await step("HCS anchor + mirror verify", async () => {
  const a = h.anchor();
  const ref = await a.anchor({ toSeq: 1, entryHash, siteId: "smoke", subject: "SMOKE" });
  await new Promise((r) => setTimeout(r, 6000)); // mirror node lag
  return { ref, verify: await a.verify({ toSeq: 1, entryHash, ref: ref.ref, data: ref.data }) };
});

if (cfg.PAYMENTS === "hedera") await step("Agent payment (1 HBAR)", () => h.payments().pay({ vendor: "vendor", amount: 1, memo: "ordo smoke", incidentHash: entryHash }));

const pol = loadPolicy(readFileSync(cfg.POLICY_FILE, "utf8"));
const check = h.policyRegistryCheck(pol.policy.id, pol.hash);
if (check) await step("Policy registry matches local policy", check);
process.exit(0);
