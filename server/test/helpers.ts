import { loadConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { buildSystem } from "../src/wiring.js";

export async function makeSystem(env: Record<string, string> = {}) {
  const cfg = loadConfig({ DATA_DIR: "memory", POLICY_FILE: "../policies/line-02.v1.yaml", TICK_MS: "1000", ...env });
  const sys = await buildSystem(cfg);
  const app = createApp(sys, { allowTamper: true });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as any };
  };
  /** Advance plant minutes synchronously until `until` is true, letting async incident work finish. */
  const stepUntil = async (until: () => Promise<boolean> | boolean, max = 120) => {
    for (let i = 0; i < max; i++) {
      sys.orchestrator.step();
      await sys.orchestrator.idle();
      if (await until()) return i + 1;
    }
    throw new Error("condition not reached");
  };
  return { sys, app, call, stepUntil };
}
