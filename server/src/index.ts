import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { buildSystem } from "./wiring.js";

const cfg = loadConfig();
const sys = await buildSystem(cfg);
for (const w of sys.warnings) console.warn(`[ordo] ${w}`);
const app = createApp(sys, {
  webDist: cfg.WEB_DIST,
  corsOrigins: cfg.CORS_ORIGINS ? cfg.CORS_ORIGINS.split(",").map((s) => s.trim()) : [],
  allowTamper: true,
});
if (cfg.SIM_AUTOSTART) sys.orchestrator.start();

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  const v = sys.orchestrator.view();
  console.log(`[ordo] listening on :${info.port} · db=${sys.db.kind} · llm=${v.mode.llm} · anchor=${v.mode.anchor} · payments=${v.mode.payments} · identity=${v.mode.identity}`);
});

const shutdown = async () => {
  server.close();
  await sys.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
