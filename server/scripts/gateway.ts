/**
 * Ordo's edge gateway for one machine: pushes its counters and signs each finished stage's counts with its own key.
 *
 *   GATEWAY_KEY=0x… ORDO_URL=https://… GATEWAY_ASSET=ast_… pnpm --filter @ordo/server gateway            (simulated machine)
 *   … MTCONNECT_URL=http://agent:5000 MTCONNECT_DEVICE=Mazak pnpm --filter @ordo/server gateway               (a real machine)
 *
 * Without GATEWAY_KEY it prints a new key and its address: set the asset's data source to "gateway" with that address,
 * and the site issues it a member name with the device role. GATEWAY_EVERY_S (default 10) is the cycle; SIM_CYCLE_S
 * and SIM_SCRAP_EVERY shape the simulated machine.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Gateway } from "../src/edge/gateway.js";

const key = process.env.GATEWAY_KEY;
if (!key) {
  const k = generatePrivateKey();
  console.log(`No GATEWAY_KEY: here is a new one. Keep it on the gateway only.\n\nGATEWAY_KEY=${k}\naddress ${privateKeyToAccount(k).address}  (the asset's gateway data source)`);
  process.exit(0);
}
const need = (n: string) => process.env[n] ?? (() => { throw new Error(`Set ${n}`); })();
const gw = new Gateway({
  url: need("ORDO_URL"),
  key: key.replace(/^(0x)?/, "0x") as Hex,
  assetId: need("GATEWAY_ASSET"),
  source: process.env.MTCONNECT_URL
    ? { kind: "mtconnect", agentUrl: process.env.MTCONNECT_URL, device: need("MTCONNECT_DEVICE") }
    : { kind: "simulate", cycleS: Number(process.env.SIM_CYCLE_S ?? 6), scrapEvery: Number(process.env.SIM_SCRAP_EVERY ?? 0) },
  log: (l) => console.log(`[gateway] ${l}`),
});
const every = Number(process.env.GATEWAY_EVERY_S ?? 10) * 1000;
console.log(`[gateway] ${gw.account.address} → ${process.env.ORDO_URL} for ${process.env.GATEWAY_ASSET}`);
for (;;) {
  await gw.tick().catch((e: unknown) => console.error(`[gateway] ${e instanceof Error ? e.message : e}`));
  await new Promise((r) => setTimeout(r, every));
}
