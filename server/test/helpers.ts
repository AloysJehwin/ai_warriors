import { loadConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { buildSystem } from "../src/wiring.js";

export const TICK = 1000;

export async function makeSystem(env: Record<string, string> = {}, appOpts: { passcode?: string } = {}) {
  const clock = { t: 1_000_000 };
  const cfg = loadConfig({ DATA_DIR: "memory", POLICY_FILE: "../policies/line-02.v1.yaml", TICK_MS: String(TICK), ...env });
  const sys = await buildSystem(cfg, { now: () => clock.t });
  const app = createApp(sys, { allowTamper: true, ...appOpts });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as any };
  };
  /** Move the fake clock one plant minute at a time and let the engine react, until `until` holds. */
  const stepUntil = async (until: () => Promise<boolean> | boolean, max = 120) => {
    for (let i = 0; i < max; i++) {
      clock.t += TICK;
      await sys.orchestrator.advance();
      if (await until()) return i + 1;
    }
    throw new Error("condition not reached");
  };
  return { sys, app, call, stepUntil, clock };
}
