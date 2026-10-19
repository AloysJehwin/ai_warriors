import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { z } from "zod";
import { SESSION_COOKIE, type Principal } from "../auth/auth.js";
import { ASSESSMENT_PATH, assessVibration } from "../chain/x402.js";
import { CATEGORIES } from "../core/templates.js";
import { REJECT } from "../core/inbox.js";
import { ONBOARDING_KINDS } from "../core/trust.js";
import { canApproveAny } from "../domain/policy.js";
import { AGENT_INFO, AGENTS, ASSET_KIND_LABEL, ASSET_KINDS, AgentKey, AssetKind, AutonomyLevel, DataSource, PackageType, Role, ROLE_LABEL, ROLES, SignalLimit, TemplateSpec } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { probeDevices } from "../plant/mtconnect.js";
import type { System } from "../wiring.js";

export interface AppOptions {
  webDist?: string;
  corsOrigins?: string[];
  secureCookies?: boolean;
  build?: { env: string; commit: string | null };
}
type Env = { Variables: { principal: Principal | null; siteId: string; roles: Role[] } };

const Hex = z.string().regex(/^0x[0-9a-fA-F]+$/) as unknown as z.ZodType<`0x${string}`>;
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const SignedBody = z.object({ nonce: z.string().min(8), signature: Hex });
const AssetBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: AssetKind,
  zoneId: z.string().nullable().default(null),
  description: z.string().max(300).nullable().default(null),
  owningAgent: AgentKey,
  source: DataSource,
  limits: z.record(z.string(), SignalLimit).default({}),
  idealCycleS: z.number().positive().nullable().default(null),
});

export function createApp(sys: System, opts: AppOptions = {}) {
  const app = new Hono<Env>();
  if (opts.corsOrigins?.length) app.use("/v1/*", cors({ origin: opts.corsOrigins, credentials: true, allowHeaders: ["content-type"] }));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  const host = (c: Context) => c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost";

  // CSRF: a state-changing request from a browser must come from this origin (or an allowed one).
  app.use("/v1/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin) {
        const o = new URL(origin).host;
        if (o !== host(c) && !(opts.corsOrigins ?? []).includes(origin)) throw new HttpError(403, "Cross-site request blocked");
      }
    }
    c.set("principal", await sys.auth.principal(getCookie(c, SESSION_COOKIE)));
    await next();
  });

  const me = (c: Context<Env>) => {
    const p = c.get("principal");
    if (!p) throw new HttpError(401, "Sign in with your wallet");
    return p;
  };
  const need = (c: Context<Env>, ...roles: Role[]) => {
    const have = c.get("roles");
    if (!roles.some((r) => canApproveAny(have, r))) throw new HttpError(403, `Needs ${roles.map((r) => ROLE_LABEL[r]).join(" or ")}`);
  };
  const actor = (c: Context<Env>) => `user:${me(c).user.address}`;
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => schema.parse(await c.req.json().catch(() => ({})));

  // ---------------- Public ----------------
  app.get("/health", (c) => c.json({ status: "ok", db: sys.db.kind, ...opts.build }));
  app.get("/v1/status", async (c) =>
    c.json({
      rails: sys.rails,
      warnings: sys.warnings,
      policy: { id: sys.policy.policy.id, version: sys.policy.policy.version, hash: sys.policy.hash },
      build: opts.build ?? null,
      signatureChainId: sys.cfg.SIGNATURE_CHAIN_ID,
      trust: sys.trust.chain
        ? { chainId: sys.trust.chain.cfg.chainId, name: sys.trust.chain.cfg.name, rpcUrl: sys.trust.chain.cfg.rpcUrl, explorerUrl: sys.trust.chain.cfg.explorerUrl, address: sys.trust.chain.cfg.address, symbol: sys.trust.chain.cfg.symbol, decimals: sys.trust.chain.cfg.decimals, workOrders: sys.trust.chain.cfg.workOrders ?? null, policies: sys.trust.chain.cfg.policies ?? null }
        : null,
      restrictedSiteCreation: Boolean(sys.cfg.BOOTSTRAP_ADMIN_ADDRESS),
    }),
  );
  app.get("/v1/meta", (c) =>
    c.json({
      roles: ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r] })),
      agents: AGENTS.map((a) => ({ key: a, ...AGENT_INFO[a] })),
      assetKinds: ASSET_KINDS.map((k) => ({ key: k, label: ASSET_KIND_LABEL[k] })),
      categories: CATEGORIES,
      packageTypes: PackageType.options,
      policy: sys.policy.policy,
    }),
  );

  // ---------------- Auth (Sign-In with Ethereum) ----------------
  app.post("/v1/auth/nonce", async (c) => c.json({ nonce: await sys.auth.issueNonce(), domain: host(c), uri: `${c.req.header("x-forwarded-proto") ?? "http"}://${host(c)}` }));
  app.post("/v1/auth/verify", async (c) => {
    const b = await body(c, z.object({ message: z.string().min(20).max(4000), signature: Hex }));
    const { token, principal } = await sys.auth.signIn({ message: b.message, signature: b.signature, domain: host(c), userAgent: c.req.header("user-agent") });
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: opts.secureCookies ?? false, path: "/", maxAge: sys.cfg.SESSION_TTL_HOURS * 3600 });
    await sys.rec.event(`user:${principal.user.address}`, "auth.signed_in", null, { userAgent: c.req.header("user-agent")?.slice(0, 120) ?? null });
    return c.json(await meView(principal));
  });
  app.post("/v1/auth/logout", async (c) => {
    const p = c.get("principal");
    if (p) await sys.auth.signOut(p.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  const meView = async (p: Principal) => {
    const ens = sys.ensNames ? (await sys.ensNames.lookup([p.user.address]))[p.user.address] ?? null : null;
    const canCreateSite = !sys.cfg.BOOTSTRAP_ADMIN_ADDRESS || sys.cfg.BOOTSTRAP_ADMIN_ADDRESS.toLowerCase() === p.user.address;
    return { user: { ...p.user, ens }, memberships: p.memberships, canCreateSite };
  };
  app.get("/v1/me", async (c) => {
    const p = c.get("principal");
    if (!p) return c.json({ user: null, memberships: [], canCreateSite: false });
    return c.json(await meView(p));
  });
  app.patch("/v1/me", async (c) => {
    const b = await body(c, z.object({ displayName: z.string().trim().min(1).max(60) }));
    await sys.auth.setDisplayName(me(c).user.id, b.displayName);
    return c.json(await meView((await sys.auth.principal(getCookie(c, SESSION_COOKIE)))!));
  });

  app.post("/v1/sites", async (c) => {
    const p = me(c);
    if (sys.cfg.BOOTSTRAP_ADMIN_ADDRESS && sys.cfg.BOOTSTRAP_ADMIN_ADDRESS.toLowerCase() !== p.user.address) throw new HttpError(403, "Only the configured administrator wallet can create sites");
    const b = await body(c, z.object({ name: z.string().trim().min(2).max(80), timezone: z.string().min(1).max(60), lineName: z.string().trim().min(1).max(60), zones: z.array(z.string().max(60)).max(20) }));
    const id = await sys.plant.createSite(b, p.user.id);
    await sys.rec.decide(id, { agent: `user:${p.user.address}`, kind: "site.created", summary: `Created site ${b.name} with line ${b.lineName}` });
    return c.json({ id });
  });

  // ---------------- Onboarding (any signed-in wallet, member or not) ----------------
  const OnboardingBody = z.object({
    siteId: z.string().min(3).max(60),
    kind: z.enum(ONBOARDING_KINDS),
    role: z.string().min(2).max(40),
    form: z.record(z.string(), z.string().max(2000)).refine((f) => Object.keys(f).length <= 20, "Too many fields"),
  });
  app.get("/v1/onboarding/site/:siteId", async (c) => {
    me(c);
    return c.json(await sys.trust.publicSite(c.req.param("siteId")));
  });
  app.get("/v1/onboarding/mine", async (c) => c.json(await sys.trust.mine(me(c).user)));
  app.post("/v1/onboarding", async (c) => {
    const b = await body(c, OnboardingBody);
    return c.json(await sys.trust.submit(b.siteId, me(c).user, b));
  });
  app.post("/v1/onboarding/:siteId/requests/:id/files", async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, "Attach a file");
    return c.json(await sys.trust.attach(c.req.param("siteId"), me(c).user, c.req.param("id"), { name: file.name, mime: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) }));
  });

  // ---------------- Lot passports: public, no sign-in (the QR code on a shipped lot and the NFT metadata) ----------------
  app.get("/v1/public/passports/:runId", async (c) => {
    const id = c.req.param("runId");
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(404, "No passport for this lot");
    c.header("access-control-allow-origin", "*");
    c.header("cache-control", "public, max-age=30");
    return c.json(await sys.passports.publicView(id));
  });

  // ---------------- x402: vibration assessments sold per call, paid in HBAR (no sign-in; the payment is the credential) ----------------
  const Assess = z.object({
    machineClass: z.enum(["medium", "large"]).default("medium"),
    samples: z.array(z.object({ t: z.number().finite(), v: z.number().finite().min(0).max(1000) })).min(3).max(5000),
  });
  const x402Cors = cors({ origin: "*", allowHeaders: ["content-type", "payment-signature", "x-payment"], exposeHeaders: ["payment-required", "payment-response"] });
  app.get("/v1/x402", (c) => {
    c.header("access-control-allow-origin", "*");
    return c.json(sys.x402 ? { offers: [{ method: "POST", path: ASSESSMENT_PATH, ...sys.x402.terms, unit: "tinybar" }] } : { offers: [] });
  });
  app.use(ASSESSMENT_PATH, x402Cors);
  app.use(ASSESSMENT_PATH, async (c, next) => {
    if (!sys.x402) throw new HttpError(404, "This deployment does not sell assessments");
    return sys.x402.middleware(c, next);
  });
  app.post(ASSESSMENT_PATH, async (c) => c.json(assessVibration(await body(c, Assess))));

  // ---------------- Site scope ----------------
  const site = new Hono<Env>();
  site.use("*", async (c, next) => {
    const p = me(c);
    const siteId = c.req.param("siteId")!;
    const m = p.memberships.find((x) => x.siteId === siteId);
    if (!m) throw new HttpError(403, "You are not a member of this site");
    c.set("siteId", siteId);
    c.set("roles", m.roles);
    await next();
  });
  const sid = (c: Context<Env>) => c.get("siteId");

  site.get("/", async (c) => c.json({ ...(await sys.plant.site(sid(c))), myRoles: c.get("roles") }));
  site.patch("/", async (c) => {
    need(c, "admin");
    await sys.plant.updateSite(sid(c), await body(c, z.object({ name: z.string().trim().min(2).max(80).optional(), timezone: z.string().max(60).optional() })));
    return c.json(await sys.plant.site(sid(c)));
  });
  site.post("/zones", async (c) => {
    need(c, "admin", "plant_manager");
    const b = await body(c, z.object({ name: z.string().trim().min(1).max(60) }));
    return c.json({ id: await sys.plant.addZone(sid(c), b.name) });
  });
  site.patch("/zones/:zoneId", async (c) => {
    need(c, "admin", "plant_manager");
    await sys.plant.renameZone(sid(c), c.req.param("zoneId"), (await body(c, z.object({ name: z.string().trim().min(1).max(60) }))).name);
    return c.json({ ok: true });
  });
  site.delete("/zones/:zoneId", async (c) => {
    need(c, "admin", "plant_manager");
    await sys.plant.deleteZone(sid(c), c.req.param("zoneId"));
    return c.json({ ok: true });
  });

  // Autonomy is a policy decision: lowering takes one plant manager's signature, raising takes two.
  site.post("/lines/:lineId/autonomy/sign-request", async (c) => {
    const b = await body(c, z.object({ level: AutonomyLevel, comment: z.string().max(500).default(""), chainId: z.number().int().optional() }));
    return c.json(await sys.autonomy.request(sid(c), me(c).user, c.get("roles"), c.req.param("lineId"), b));
  });
  site.put("/lines/:lineId/autonomy", async (c) => {
    const b = await body(c, SignedBody.extend({ level: AutonomyLevel, comment: z.string().max(500).default("") }));
    const proposal = await sys.autonomy.sign(sid(c), me(c).user, c.get("roles"), c.req.param("lineId"), b);
    return c.json({ site: await sys.plant.site(sid(c)), proposal });
  });
  site.get("/autonomy/proposals", async (c) => c.json(await sys.autonomy.list(sid(c))));

  // ---- Team ----
  site.get("/team", async (c) => {
    const t = await sys.plant.team(sid(c));
    const issued = await sys.names.ofPeople(sid(c));
    const ens = sys.ensNames ? await sys.ensNames.lookup(t.members.map((m) => m.address)) : {};
    return c.json({ ...t, members: t.members.map((m) => ({ ...m, ens: issued.get(m.address.toLowerCase()) ?? ens[m.address] ?? null })) });
  });

  // ---- ENS names (ENSv2 on Sepolia) ----
  site.get("/names", async (c) => c.json({ live: sys.names.live, parent: sys.names.parent, items: await sys.names.list(sid(c)) }));
  site.post("/names/:kind/:ref/retry", async (c) => {
    need(c, "admin");
    await sys.names.retry(sid(c), c.req.param("kind"), c.req.param("ref"));
    return c.json({ ok: true });
  });
  site.post("/team/invites", async (c) => {
    need(c, "admin");
    const b = await body(c, z.object({ address: Address, role: Role }));
    const r = await sys.plant.invite(sid(c), b.address, b.role, me(c).user.id);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "team.invited", summary: `${r.added ? "Added" : "Invited"} ${b.address} as ${ROLE_LABEL[b.role]}` });
    return c.json(r);
  });
  site.delete("/team/invites/:id", async (c) => {
    need(c, "admin");
    await sys.plant.cancelInvite(sid(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  site.delete("/team/members/:userId/roles/:role", async (c) => {
    need(c, "admin");
    const role = Role.parse(c.req.param("role"));
    await sys.plant.removeRole(sid(c), c.req.param("userId"), role);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "team.role_removed", summary: `Removed ${ROLE_LABEL[role]} from ${c.req.param("userId")}` });
    return c.json({ ok: true });
  });

  // ---- Assets & data sources ----
  const assetAdmin = (c: Context<Env>) => need(c, "admin", "process_engineer", "maintenance_lead");
  site.get("/assets", async (c) => c.json(await sys.plant.views(sid(c))));
  site.post("/assets/probe", async (c) => {
    assetAdmin(c);
    const b = await body(c, z.object({ agentUrl: z.string().url() }));
    return c.json({ devices: await probeDevices(b.agentUrl).catch((e: unknown) => Promise.reject(new HttpError(502, `Could not read the MTConnect agent: ${e instanceof Error ? e.message : e}`))) });
  });
  site.post("/assets", async (c) => {
    assetAdmin(c);
    const b = await body(c, AssetBody);
    const id = await sys.plant.createAsset(sid(c), b, me(c).user.id);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "asset.created", assetId: id, summary: `Registered ${b.name} (${ASSET_KIND_LABEL[b.kind]}) · ${b.source.type}` });
    await sys.advance(true);
    return c.json({ id });
  });
  site.get("/assets/:assetId", async (c) => {
    const id = c.req.param("assetId");
    const view = (await sys.plant.views(sid(c))).find((a) => a.id === id);
    if (!view) throw new HttpError(404, "Asset not found");
    const minutes = Math.min(24 * 60, Number(c.req.query("minutes") ?? 60));
    const signals = [...new Set([...Object.keys(view.limits), ...Object.keys(view.latest).filter((k) => view.latest[k]!.value !== null)])].slice(0, 8);
    const series: Record<string, { ts: number; value: number | null }[]> = {};
    for (const s of signals) series[s] = (await sys.plant.series(id, s, minutes)).map((p) => ({ ts: p.ts, value: p.value }));
    const asset = await sys.plant.asset(sid(c), id);
    return c.json({ view, asset, series, replays: await sys.plant.replays(sid(c), id) });
  });
  site.put("/assets/:assetId", async (c) => {
    assetAdmin(c);
    const b = await body(c, AssetBody);
    await sys.plant.updateAsset(sid(c), c.req.param("assetId"), b);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "asset.updated", assetId: c.req.param("assetId"), summary: `Updated ${b.name}` });
    return c.json({ ok: true });
  });
  site.delete("/assets/:assetId", async (c) => {
    assetAdmin(c);
    await sys.plant.archiveAsset(sid(c), c.req.param("assetId"));
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "asset.archived", assetId: c.req.param("assetId"), summary: `Archived asset` });
    return c.json({ ok: true });
  });
  site.post("/assets/:assetId/readings", async (c) => {
    need(c, "operator");
    const b = await body(c, z.object({ signal: z.string().trim().min(1).max(40), value: z.number().nullable().default(null), text: z.string().max(80).nullable().default(null) }));
    await sys.plant.manualReading(sid(c), c.req.param("assetId"), b);
    await sys.rec.event(actor(c), "telemetry.manual", c.req.param("assetId"), b);
    return c.json({ ok: true });
  });
  site.post("/assets/:assetId/replays", async (c) => {
    assetAdmin(c);
    const csv = await c.req.text();
    if (csv.length > 4_000_000) throw new HttpError(400, "CSV is limited to 4 MB");
    const r = await sys.plant.uploadReplay(sid(c), c.req.param("assetId"), c.req.query("name") ?? "dataset.csv", csv, me(c).user.id);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "dataset.uploaded", assetId: c.req.param("assetId"), summary: `Uploaded ${c.req.query("name") ?? "dataset"}: ${r.rows} rows of ${r.signals.join(", ")}` });
    return c.json(r);
  });
  site.post("/assets/:assetId/replays/:seriesId/start", async (c) => {
    assetAdmin(c);
    const b = await body(c, z.object({ speed: z.number().min(0.1).max(600).default(1) }));
    await sys.plant.startReplay(sid(c), c.req.param("assetId"), c.req.param("seriesId"), b.speed);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "dataset.replay_started", assetId: c.req.param("assetId"), summary: `Started dataset replay at ${b.speed}×` });
    return c.json({ ok: true });
  });

  // ---- Templates & builder ----
  site.get("/templates", async (c) => c.json(await sys.templates.list(sid(c))));
  site.get("/templates/:templateId", async (c) => c.json(await sys.templates.get(sid(c), c.req.param("templateId"))));
  site.post("/templates", async (c) => {
    need(c, "process_engineer");
    const b = await body(c, z.object({ templateId: z.string().optional(), name: z.string().trim().min(2).max(80), category: z.string().trim().min(2).max(40), description: z.string().max(300).default(""), spec: TemplateSpec, note: z.string().max(200).optional() }));
    return c.json(await sys.templates.publish(sid(c), actor(c), b));
  });
  site.delete("/templates/:templateId", async (c) => {
    need(c, "process_engineer");
    await sys.templates.archive(sid(c), c.req.param("templateId"));
    return c.json({ ok: true });
  });

  // ---- Runs ----
  site.get("/runs", async (c) => c.json(await sys.engine.list(sid(c), { days: Number(c.req.query("days") ?? 7), status: (c.req.query("status") || undefined) as never })));
  site.post("/runs", async (c) => {
    need(c, "supervisor");
    const b = await body(c, z.object({ templateVersionId: z.string(), orderRef: z.string().trim().min(1).max(60), quantity: z.number().int().min(1).max(1_000_000), dueAt: z.string().datetime().nullable().optional(), lineId: z.string().optional() }));
    const id = await sys.engine.start(sid(c), actor(c), b);
    return c.json(await sys.engine.view(sid(c), id));
  });
  site.get("/runs/:runId/passport", async (c) => c.json(await sys.passports.get(sid(c), c.req.param("runId"))));
  const ShipTo = z.object({ to: z.string().regex(/^(0\.0\.\d+|0x[0-9a-fA-F]{40})$/, "A Hedera account id (0.0.x) or an EVM address") });
  site.post("/runs/:runId/ship/sign-request", async (c) => c.json(await sys.passports.shipRequest(sid(c), me(c).user, c.get("roles"), c.req.param("runId"), (await body(c, ShipTo)).to)));
  site.post("/runs/:runId/ship", async (c) => c.json(await sys.passports.ship(sid(c), me(c).user, c.get("roles"), c.req.param("runId"), await body(c, SignedBody.merge(ShipTo)))));
  site.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const [run, decisions, inbox] = await Promise.all([sys.engine.view(sid(c), runId), sys.rec.decisions(sid(c), { runId, limit: 200 }), sys.inbox.list(sid(c), { runId, status: "all" })]);
    return c.json({ run, decisions, inbox });
  });
  site.post("/runs/:runId/step", async (c) => {
    need(c, "supervisor");
    const r = await sys.engine.step(sid(c), actor(c), c.req.param("runId"));
    return c.json({ ...r, run: await sys.engine.view(sid(c), c.req.param("runId")) });
  });
  site.post("/runs/:runId/abort", async (c) => {
    need(c, "plant_manager");
    await sys.engine.abort(sid(c), actor(c), c.req.param("runId"), (await body(c, z.object({ reason: z.string().trim().min(3).max(300) }))).reason);
    return c.json(await sys.engine.view(sid(c), c.req.param("runId")));
  });
  site.post("/runs/:runId/stages/:code/record", async (c) => {
    need(c, "operator");
    const b = await body(c, z.object({ good: z.number().int().min(0), scrap: z.number().int().min(0), complete: z.boolean().default(false), note: z.string().max(300).optional() }));
    await sys.engine.record(sid(c), actor(c), c.req.param("runId"), c.req.param("code"), b);
    return c.json(await sys.engine.view(sid(c), c.req.param("runId")));
  });
  site.post("/runs/:runId/stages/:code/hold", async (c) => {
    need(c, "operator");
    const b = await body(c, z.object({ reason: z.string().trim().min(3).max(300) }));
    await sys.engine.hold(sid(c), actor(c), c.req.param("runId"), c.req.param("code"), b.reason);
    return c.json(await sys.engine.view(sid(c), c.req.param("runId")));
  });
  site.post("/runs/:runId/stages/:code/reassign", async (c) => {
    need(c, "supervisor");
    const b = await body(c, z.object({ assetId: z.string() }));
    await sys.engine.reassign(sid(c), actor(c), c.req.param("runId"), c.req.param("code"), b.assetId);
    return c.json(await sys.engine.view(sid(c), c.req.param("runId")));
  });

  // ---- Inbox (approvals & exceptions) ----
  site.get("/inbox", async (c) => c.json(await sys.inbox.list(sid(c), { status: c.req.query("status") ?? "pending" })));
  const OptionBody = z.object({ option: z.number().int().min(REJECT), comment: z.string().max(500).default("") });
  site.post("/inbox/:id/sign-request", async (c) => {
    const b = await body(c, OptionBody.extend({ chainId: z.number().int().optional() }));
    return c.json(await sys.inbox.signatureRequest(sid(c), me(c).user, c.get("roles"), c.req.param("id"), b.option, b.comment, b.chainId));
  });
  site.post("/inbox/:id/decide", async (c) => {
    const b = await body(c, OptionBody.merge(SignedBody));
    return c.json(await sys.inbox.decide(sid(c), me(c).user, c.get("roles"), c.req.param("id"), { option: b.option, reason: b.comment, nonce: b.nonce, signature: b.signature }));
  });

  // ---- Decisions, agents, incidents ----
  site.get("/decisions", async (c) => c.json(await sys.rec.decisions(sid(c), { runId: c.req.query("runId") || undefined, limit: Number(c.req.query("limit") ?? 50) })));
  site.get("/incidents", async (c) => {
    const r = await sys.db.query<{ id: string; asset_id: string; status: string; title: string; severity: string; opened_at: string; closed_at: string | null }>(
      "SELECT id, asset_id, status, title, severity, opened_at::text, closed_at::text FROM incidents WHERE site_id = $1 ORDER BY opened_at DESC LIMIT 50",
      [sid(c)],
    );
    return c.json(r.rows.map((x) => ({ id: x.id, assetId: x.asset_id, status: x.status, title: x.title, severity: x.severity, openedAt: new Date(x.opened_at).toISOString(), closedAt: x.closed_at ? new Date(x.closed_at).toISOString() : null })));
  });
  site.get("/agents", async (c) => {
    const s = await sys.plant.site(sid(c));
    const level = s.lines[0]?.autonomy ?? "L2";
    const stats = await sys.db.query<{ agent: string; n: string; conf: string | null }>(
      "SELECT agent, COUNT(*)::text n, AVG(confidence)::text conf FROM decisions WHERE site_id = $1 AND ts > now() - interval '24 hours' AND agent LIKE 'agent:%' GROUP BY agent",
      [sid(c)],
    );
    const esc = await sys.db.query<{ agent: string; n: string }>("SELECT agent, COUNT(*)::text n FROM inbox_items WHERE site_id = $1 AND created_at > now() - interval '24 hours' GROUP BY agent", [sid(c)]);
    const tasks = await sys.db.query<{ run_id: string; code: string; name: string | null; spec_json: string; state: string }>(
      "SELECT sr.run_id, sr.code, sr.data_json::json->>'name' AS name, v.spec_json, sr.state FROM stage_runs sr JOIN runs r ON r.id = sr.run_id JOIN template_versions v ON v.id = r.template_version_id WHERE r.site_id = $1 AND r.status = 'running' AND sr.state IN ('running','awaiting_approval','held')",
      [sid(c)],
    );
    const views = await sys.plant.views(sid(c));
    const nfts = await sys.agentNfts.ofSite(sid(c));
    return c.json(
      AGENTS.map((a) => {
        const st = stats.rows.find((x) => x.agent === `agent:${a}`);
        const current = tasks.rows.filter((t) => (JSON.parse(t.spec_json) as TemplateSpec).stages.find((s) => s.code === t.code)?.agent === a);
        return {
          key: a,
          ...AGENT_INFO[a],
          inft: nfts.get(a) ?? null,
          autonomy: level,
          assets: views.filter((v) => v.owningAgent === a).map((v) => ({ id: v.id, name: v.name, status: v.status })),
          currentTask: current[0] ? `${current[0].run_id} · ${current[0].code} ${current[0].name ?? ""}`.trim() : null,
          activeStages: current.length,
          decisionsToday: Number(st?.n ?? 0),
          escalationsToday: Number(esc.rows.find((x) => x.agent === `agent:${a}`)?.n ?? 0),
          avgConfidence: st?.conf ? Number(st.conf) : null,
        };
      }),
    );
  });

  // ---- Validation packages ----
  site.get("/validation", async (c) => c.json(await sys.validation.list(sid(c), me(c).user, c.get("roles"))));
  const PackageFields = z.object({
    title: z.string().trim().min(3).max(120),
    objective: z.string().max(2000).default(""),
    acceptance: z.string().max(2000).default(""),
    samplePlan: z.string().max(1000).default(""),
    windowStart: z.string().datetime().nullable().optional(),
    windowEnd: z.string().datetime().nullable().optional(),
  });
  site.post("/validation", async (c) => {
    need(c, "process_engineer");
    const b = await body(c, PackageFields.extend({ type: PackageType, runId: z.string().nullable().optional(), stageCode: z.string().nullable().optional(), templateId: z.string().nullable().optional(), assetId: z.string().nullable().optional() }));
    return c.json(await sys.validation.create(sid(c), me(c).user, b));
  });
  site.get("/validation/:id", async (c) => c.json(await sys.validation.get(sid(c), c.req.param("id"))));
  site.patch("/validation/:id", async (c) => c.json(await sys.validation.update(sid(c), me(c).user, c.req.param("id"), await body(c, PackageFields.partial()))));
  site.post("/validation/:id/checks", async (c) =>
    c.json(await sys.validation.addCheck(sid(c), me(c).user, c.req.param("id"), await body(c, z.object({ criterion: z.string().trim().min(2).max(200), method: z.string().max(200).default("Manual"), target: z.string().max(100).default("") })))),
  );
  site.patch("/validation/:id/checks/:checkId", async (c) =>
    c.json(await sys.validation.recordCheck(sid(c), me(c).user, c.req.param("id"), c.req.param("checkId"), await body(c, z.object({ status: z.enum(["pass", "fail"]), result: z.string().max(200).default("") })))),
  );
  site.delete("/validation/:id/checks/:checkId", async (c) => c.json(await sys.validation.removeCheck(sid(c), me(c).user, c.req.param("id"), c.req.param("checkId"))));
  site.post("/validation/:id/precheck", async (c) => c.json(await sys.validation.precheck(sid(c), me(c).user, c.req.param("id"))));
  site.post("/validation/:id/evidence", async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, "Attach a file");
    const bytes = new Uint8Array(await file.arrayBuffer());
    return c.json(await sys.validation.attach(sid(c), me(c).user, c.req.param("id"), { slotId: typeof form.slotId === "string" && form.slotId ? form.slotId : null, name: typeof form.name === "string" && form.name ? form.name : file.name, filename: file.name, mime: file.type || "application/octet-stream", bytes }));
  });
  site.delete("/validation/:id/evidence/:evidenceId", async (c) => c.json(await sys.validation.removeEvidence(sid(c), me(c).user, c.req.param("id"), c.req.param("evidenceId"))));
  site.get("/validation/:id/evidence/:evidenceId/0g", async (c) => c.json(await sys.validation.verifyOnZeroG(sid(c), c.req.param("id"), c.req.param("evidenceId"))));
  site.get("/validation/:id/evidence/:evidenceId/file", async (c) => {
    const f = await sys.validation.blob(sid(c), c.req.param("id"), c.req.param("evidenceId"));
    return new Response(Buffer.from(f.bytes), { headers: { "content-type": f.mime, "content-disposition": `attachment; filename="${f.filename.replace(/"/g, "")}"`, "x-content-type-options": "nosniff" } });
  });
  const PkgAction = z.object({ action: z.enum(["sign", "return", "reject"]), comment: z.string().max(1000).default("") });
  site.post("/validation/:id/sign-request", async (c) => {
    const b = await body(c, PkgAction.extend({ chainId: z.number().int().optional() }));
    return c.json(await sys.validation.signatureRequest(sid(c), me(c).user, c.get("roles"), c.req.param("id"), b.action, b.comment, b.chainId));
  });
  site.post("/validation/:id/act", async (c) => c.json(await sys.validation.act(sid(c), me(c).user, c.get("roles"), c.req.param("id"), await body(c, PkgAction.merge(SignedBody)))));


  // ---- Onboarding review, validators, vendors, on-chain trust ----
  site.get("/onboarding", async (c) => {
    need(c, "admin");
    return c.json(await sys.trust.list(sid(c), c.req.query("status") ?? "pending"));
  });
  site.get("/onboarding/:id/files/:sha", async (c) => {
    const r = await sys.trust.get(sid(c), c.req.param("id"));
    if (r.userId !== me(c).user.id) need(c, "admin");
    const f = await sys.trust.file(sid(c), c.req.param("id"), c.req.param("sha"));
    return new Response(Buffer.from(f.bytes), { headers: { "content-type": f.mime, "content-disposition": `attachment; filename="${f.name.replace(/"/g, "")}"`, "x-content-type-options": "nosniff" } });
  });
  const Decision = z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().max(500).default("") });
  site.post("/onboarding/:id/sign-request", async (c) => {
    need(c, "admin");
    const b = await body(c, Decision.extend({ chainId: z.number().int().optional() }));
    return c.json(await sys.trust.decisionRequest(sid(c), me(c).user, c.req.param("id"), b.decision, b.comment, b.chainId));
  });
  site.post("/onboarding/:id/decide", async (c) => {
    need(c, "admin");
    return c.json(await sys.trust.decide(sid(c), me(c).user, c.req.param("id"), await body(c, Decision.merge(SignedBody))));
  });
  site.get("/validators", async (c) => {
    const [validators, mine, chain, proposals] = await Promise.all([
      sys.trust.validators(sid(c)),
      sys.trust.isValidator(sid(c), me(c).user),
      sys.trust.chainStatus(sid(c)),
      sys.trust.proposals(sid(c)),
    ]);
    return c.json({ validators, me: { ...mine, row: await sys.trust.validatorRow(sid(c), me(c).user.id) }, chain, proposals });
  });
  site.get("/vendors", async (c) => c.json(await sys.trust.vendors(sid(c))));
  site.get("/chain", async (c) => c.json(await sys.trust.chainStatus(sid(c))));
  site.post("/chain/register/sign-request", async (c) => {
    need(c, "admin");
    const s = await sys.plant.site(sid(c));
    return c.json(await sys.trust.registerRequest(sid(c), me(c).user, s.name));
  });
  site.post("/chain/register", async (c) => {
    need(c, "admin");
    return c.json(await sys.trust.register(sid(c), me(c).user, await body(c, SignedBody)));
  });
  site.post("/chain/retry", async (c) => {
    need(c, "admin");
    return c.json(await sys.trust.retry(sid(c), (await body(c, z.object({ ref: z.string().min(3) }))).ref));
  });
  site.post("/slash", async (c) => {
    const b = await body(c, z.object({ validatorUserId: z.string(), amount: z.string().regex(/^\d+$/), reason: z.string().trim().min(10).max(1000), recallPackageId: z.string().nullable().optional() }));
    return c.json({ id: await sys.trust.propose(sid(c), me(c).user, c.get("roles"), b) });
  });
  site.post("/slash/:id/sign-request", async (c) => c.json(await sys.trust.slashRequest(sid(c), me(c).user, c.get("roles"), c.req.param("id"))));
  site.post("/slash/:id/sign", async (c) => {
    await sys.trust.signSlash(sid(c), me(c).user, c.get("roles"), c.req.param("id"), await body(c, SignedBody));
    return c.json(await sys.trust.proposals(sid(c)));
  });

  // ---- Work orders: the agent escrows vendor payments, people release them ----
  const Caps = z.object({ perOrder: z.string().regex(/^\d+$/), perDay: z.string().regex(/^\d+$/) });
  site.get("/work-orders", async (c) => c.json({ setup: await sys.workOrders.status(sid(c)), items: await sys.workOrders.list(sid(c)) }));
  site.post("/work-orders/caps/sign-request", async (c) => c.json(await sys.workOrders.capsRequest(sid(c), me(c).user, c.get("roles"), await body(c, Caps))));
  site.put("/work-orders/caps", async (c) => c.json(await sys.workOrders.setCaps(sid(c), me(c).user, c.get("roles"), await body(c, SignedBody.merge(Caps)))));
  site.post("/work-orders/pause/sign-request", async (c) => c.json(await sys.workOrders.pauseRequest(sid(c), me(c).user, c.get("roles"), (await body(c, z.object({ stop: z.boolean() }))).stop)));
  site.put("/work-orders/pause", async (c) => {
    const b = await body(c, SignedBody.extend({ stop: z.boolean() }));
    return c.json(await sys.workOrders.setPaused(sid(c), me(c).user, c.get("roles"), b.stop, b));
  });
  site.post("/work-orders/:id/release/sign-request", async (c) => c.json(await sys.workOrders.releaseRequest(sid(c), me(c).user, c.get("roles"), c.req.param("id"))));
  site.post("/work-orders/:id/release", async (c) => c.json(await sys.workOrders.release(sid(c), me(c).user, c.get("roles"), c.req.param("id"), await body(c, SignedBody))));
  site.post("/work-orders/:id/assessment/retry", async (c) => c.json(await sys.workOrders.retryAssessment(sid(c), c.get("roles"), c.req.param("id"))));
  site.post("/work-orders/:id/retry", async (c) => c.json(await sys.workOrders.retryEscrow(sid(c), c.get("roles"), c.req.param("id"))));

  // ---- Ledger & proof ----
  site.get("/ledger", async (c) => {
    const subject = c.req.query("subject") || undefined;
    return c.json({ entries: await sys.ledger.latest(Math.min(500, Number(c.req.query("limit") ?? 100)), subject), anchors: await sys.proof.anchors(20), anchorKind: sys.proof.kind });
  });
  site.get("/verify", async (c) => c.json(await sys.proof.verify(c.req.query("subject") || undefined)));
  site.post("/anchors", async (c) => {
    need(c, "supervisor");
    return c.json(await sys.proof.anchorHead(sid(c), c.req.query("subject") || null));
  });
  site.post("/summaries/shift", async (c) => {
    const entries = (await sys.ledger.latest(120)).reverse();
    const r = await sys.agents.summarize({ entries: entries.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, subject: e.subject, brief: String((e.payload as { summary?: string })?.summary ?? e.type) })) });
    return c.json({ ...r.value, modelId: r.modelId, fallback: r.fallback });
  });

  /** One call per poll: advances the engine, then returns everything a screen needs to refresh. */
  site.get("/live", async (c) => {
    await sys.advance().catch((e) => console.error("[ordo] advance", e));
    const s = sid(c);
    const [assets, runs, inbox, decisions, head, validation] = await Promise.all([
      sys.plant.views(s),
      sys.engine.list(s, { days: 7 }),
      sys.inbox.list(s, { status: "pending" }),
      sys.rec.decisions(s, { limit: 30 }),
      sys.ledger.head(),
      sys.validation.list(s, me(c).user, c.get("roles")),
    ]);
    const roles = c.get("roles");
    return c.json({
      now: new Date().toISOString(),
      assets,
      runs,
      inbox,
      decisions,
      headSeq: head?.seq ?? 0,
      counts: {
        approvals: inbox.filter((i) => canApproveAny(roles, i.requiredRole)).length,
        validation: validation.filter((v) => v.needsMe).length,
        onboarding: canApproveAny(roles, "admin") ? (await sys.trust.list(s, "pending")).length : 0,
        workOrders: canApproveAny(roles, "maintenance_lead") ? (await sys.db.query("SELECT 1 FROM work_orders WHERE site_id = $1 AND status IN ('escrowed', 'escrow_failed')", [s])).rows.length : 0,
        autonomy: canApproveAny(roles, "plant_manager") ? (await sys.autonomy.list(s)).filter((p) => p.status === "open" && !p.signers.some((x) => x.address === me(c).user.address)).length : 0,
      },
    });
  });

  app.route("/v1/sites/:siteId", site);

  // ---------------- Web console (single-container mode) ----------------
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
