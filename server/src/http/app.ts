import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { SCENARIOS } from "../domain/simulator.js";
import { AutonomyLevel, Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { System } from "../wiring.js";

const ActorBody = z.object({ actor: z.object({ name: z.string().min(1).max(60), role: Role }), reason: z.string().max(500).optional() });

export function createApp(sys: System, opts: { webDist?: string; corsOrigins?: string[]; allowTamper?: boolean } = {}) {
  const app = new Hono();
  const o = sys.orchestrator;

  if (opts.corsOrigins?.length) app.use("/v1/*", cors({ origin: opts.corsOrigins }));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok", minute: o.plant.minute, db: sys.db.kind }));

  // ---- Plant & simulator ----
  app.get("/v1/plant", (c) => c.json(o.view()));
  app.post("/v1/sim/scenarios/:name/start", async (c) => {
    const name = z.enum(SCENARIOS).parse(c.req.param("name"));
    const seed = c.req.query("seed");
    await o.reset(name, seed ? Number(seed) : undefined, "user:demo");
    o.start();
    return c.json(o.view());
  });
  app.post("/v1/sim/pause", (c) => {
    o.stop();
    return c.json(o.view());
  });
  app.post("/v1/sim/resume", (c) => {
    o.start();
    return c.json(o.view());
  });
  app.post("/v1/sim/step", async (c) => {
    const n = Math.min(240, Math.max(1, Number(c.req.query("minutes") ?? 1)));
    for (let i = 0; i < n; i++) o.step();
    return c.json(o.view());
  });

  app.patch("/v1/line/autonomy", async (c) => {
    const body = ActorBody.extend({ level: AutonomyLevel }).parse(await c.req.json());
    await o.setAutonomy(body.level, body.actor);
    return c.json(o.view());
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
  app.get("/v1/verify/incidents/:id", async (c) => {
    const t = c.req.query("tamper");
    const tamper = t && opts.allowTamper !== false ? Number(t) : null;
    return c.json(await o.verify(c.req.param("id"), Number.isFinite(tamper) ? tamper : null));
  });
  app.post("/v1/summaries/shift", async (c) => c.json(await o.shiftSummary()));

  // ---- Live stream (Server-Sent Events) ----
  app.get("/v1/stream", (c) =>
    streamSSE(c, async (stream) => {
      const queue: { id: number; data: string; event: string }[] = [];
      let wake: (() => void) | null = null;
      const off = sys.bus.on((id, e) => {
        // Collapse plant ticks: only the newest matters.
        if (e.type === "plant.tick") {
          const i = queue.findIndex((q) => q.event === "plant.tick");
          if (i >= 0) queue.splice(i, 1);
        }
        queue.push({ id, event: e.type, data: JSON.stringify(e) });
        wake?.();
      });
      stream.onAbort(() => {
        off();
        wake?.();
      });
      await stream.writeSSE({ event: "plant.tick", data: JSON.stringify({ type: "plant.tick", plant: o.view() }) });
      let lastPing = Date.now();
      while (!stream.aborted) {
        const next = queue.shift();
        if (next) {
          await stream.writeSSE({ id: String(next.id), event: next.event, data: next.data });
          continue;
        }
        if (Date.now() - lastPing > 15000) {
          await stream.writeSSE({ event: "ping", data: "{}" });
          lastPing = Date.now();
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 5000);
        });
        wake = null;
      }
      off();
    }),
  );

  // ---- Web console ----
  const dist = opts.webDist ? resolve(opts.webDist) : null;
  if (dist && existsSync(resolve(dist, "index.html"))) {
    const indexHtml = readFileSync(resolve(dist, "index.html"), "utf8");
    app.use("/assets/*", serveStatic({ root: dist }));
    app.get("/favicon.svg", serveStatic({ root: dist }));
    app.get("*", (c) => (c.req.path.startsWith("/v1/") ? c.json({ error: "Not found" }, 404) : c.html(indexHtml)));
  } else {
    app.get("/", (c) => c.text("Ordo API is running. Build the web console with `pnpm --filter @ordo/web build`."));
  }
  return app;
}
