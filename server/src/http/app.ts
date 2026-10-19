import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { SCENARIOS } from "../domain/simulator.js";
import { AutonomyLevel, Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { System } from "../wiring.js";

const ActorBody = z.object({ actor: z.object({ name: z.string().min(1).max(60), role: Role }), reason: z.string().max(500).optional() });

export interface AppOptions {
  webDist?: string;
  corsOrigins?: string[];
  allowTamper?: boolean;
  passcode?: string;
  build?: { env: string; commit: string | null };
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(sys: System, opts: AppOptions = {}) {
  const app = new Hono();
  const o = sys.orchestrator;

  if (opts.corsOrigins?.length) app.use("/v1/*", cors({ origin: opts.corsOrigins, allowHeaders: ["content-type", "x-ordo-passcode"] }));

  // Optional shared passcode for every write, so a public preview can't be driven by strangers.
  app.use("/v1/*", async (c, next) => {
    if (opts.passcode && c.req.method !== "GET" && c.req.method !== "OPTIONS") {
      const given = c.req.header("x-ordo-passcode") ?? "";
      if (!sameSecret(given, opts.passcode)) throw new HttpError(401, "Passcode required");
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/health", async (c) => c.json({ status: "ok", db: sys.db.kind, ...opts.build }));

  /** Which rails are real and which are local stand-ins — no secrets. */
  app.get("/v1/status", (c) =>
    c.json({
      rails: sys.rails,
      warnings: sys.warnings,
      passcodeRequired: Boolean(opts.passcode),
      policy: { id: sys.policy.policy.id, version: sys.policy.policy.version, hash: sys.policy.hash },
      build: opts.build ?? null,
    }),
  );

  /**
   * Polling endpoint for the console. Every call advances the plant to "now" (requests drive the
   * engine on serverless) and returns everything that changed after ledger seq `since`.
   */
  app.get("/v1/live", async (c) => {
    const since = Math.max(0, Number(c.req.query("since") ?? 0) || 0);
    await o.advance();
    const [plant, entries, decisions, incidents, approvals, anchors] = await Promise.all([
      o.view(),
      sys.ledger.after(since, 200),
      since ? sys.store.decisionsAfter(since, 100) : sys.store.recentDecisions(40),
      sys.store.incidents(50),
      sys.store.approvals(),
      sys.store.anchors(20),
    ]);
    return c.json({ plant, entries, decisions, incidents, approvals, anchors: anchors.map(({ data: _d, ...a }) => a) });
  });

  // ---- Plant & simulator ----
  app.get("/v1/plant", async (c) => {
    await o.advance();
    return c.json(await o.view());
  });
  app.post("/v1/sim/scenarios/:name/start", async (c) => {
    const name = z.enum(SCENARIOS).parse(c.req.param("name"));
    const seed = c.req.query("seed");
    await o.reset(name, seed ? Number(seed) : undefined, "user:demo");
    return c.json(await o.view());
  });
  app.post("/v1/sim/pause", async (c) => {
    await o.advance();
    await o.pause();
    return c.json(await o.view());
  });
  app.post("/v1/sim/resume", async (c) => {
    await o.resume();
    return c.json(await o.view());
  });
  app.post("/v1/sim/step", async (c) => {
    await o.skip(Math.min(240, Math.max(1, Number(c.req.query("minutes") ?? 1))));
    await o.advance();
    return c.json(await o.view());
  });

  app.patch("/v1/line/autonomy", async (c) => {
    const body = ActorBody.extend({ level: AutonomyLevel }).parse(await c.req.json());
    await o.setAutonomy(body.level, body.actor);
    return c.json(await o.view());
  });
  app.get("/v1/policy", (c) => c.json({ policy: sys.policy.policy, hash: sys.policy.hash }));

  // ---- Incidents, approvals ----
  app.get("/v1/incidents", async (c) => c.json(await sys.store.incidents(50)));
  app.get("/v1/incidents/:id", async (c) => {
    const id = c.req.param("id");
    const incident = await sys.store.incident(id);
    if (!incident) throw new HttpError(404, "Incident not found");
    const [decisions, approvals, entries] = await Promise.all([sys.store.decisions(id), sys.store.approvals({ incidentId: id }), sys.ledger.latest(200, id)]);
    return c.json({ incident, decisions, approvals, entries: entries.reverse() });
  });
  app.get("/v1/decisions", async (c) => c.json(await sys.store.recentDecisions(Math.min(100, Number(c.req.query("limit") ?? 40)))));
  app.get("/v1/approvals", async (c) => c.json(await sys.store.approvals({ status: c.req.query("status") || undefined })));
  app.post("/v1/approvals/:id/approve", async (c) => {
    const b = ActorBody.parse(await c.req.json());
    return c.json(await o.approve(c.req.param("id"), b.actor, b.reason));
  });
  app.post("/v1/approvals/:id/reject", async (c) => {
    const b = ActorBody.parse(await c.req.json());
    return c.json(await o.reject(c.req.param("id"), b.actor, b.reason ?? ""));
  });

  // ---- Ledger, anchors, verification ----
  app.get("/v1/ledger", async (c) => {
    const limit = Math.min(500, Number(c.req.query("limit") ?? 100));
    return c.json(await sys.ledger.latest(limit, c.req.query("incident") || undefined));
  });
  app.get("/v1/anchors", async (c) => c.json((await sys.store.anchors(50)).map(({ data: _d, ...a }) => a)));
  app.post("/v1/anchors", async (c) => {
    await o.anchorHead(null, null);
    return c.json((await sys.store.anchors(1)).map(({ data: _d, ...a }) => a)[0] ?? null);
  });
  app.get("/v1/verify/incidents/:id", async (c) => {
    const t = c.req.query("tamper");
    const tamper = t && opts.allowTamper !== false ? Number(t) : null;
    return c.json(await o.verify(c.req.param("id"), Number.isFinite(tamper) ? tamper : null));
  });
  app.post("/v1/summaries/shift", async (c) => c.json(await o.shiftSummary()));

  // ---- Web console (single-container mode) ----
  const dist = opts.webDist ? resolve(opts.webDist) : null;
  if (dist && existsSync(resolve(dist, "index.html"))) {
    const indexHtml = readFileSync(resolve(dist, "index.html"), "utf8");
    app.use("/assets/*", serveStatic({ root: dist }));
    app.get("/favicon.svg", serveStatic({ root: dist }));
    app.get("*", (c) => (c.req.path.startsWith("/v1/") ? c.json({ error: "Not found" }, 404) : c.html(indexHtml)));
  } else {
    app.get("/", (c) => c.text("Ordo API is running."));
  }
  return app;
}
