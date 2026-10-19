import { randomUUID } from "node:crypto";
import type { AnchorAdapter, ApprovalRail, EvidenceStore, IdentityResolver, PaymentRail } from "../adapters/rails.js";
import { Agents, remainingUnits, signalStats, TOOLS_DOC } from "../agents/agents.js";
import { canonicalize } from "../domain/canonical.js";
import { detectAll } from "../domain/detector.js";
import { downtimeAvoided } from "../domain/downtime.js";
import { forecast as runForecast } from "../domain/forecast.js";
import { verifyChain, type LedgerDraft, type LedgerEntry } from "../domain/ledger.js";
import { LIMITS } from "../domain/limits.js";
import { canApprove, evaluate, type Policy } from "../domain/policy.js";
import { Plant, type Scenario } from "../domain/simulator.js";
import type {
  Anomaly,
  Approval,
  AutonomyLevel,
  Decision,
  DecisionKind,
  Forecast,
  Incident,
  LedgerEntryDto,
  PlantView,
  Role,
  TelemetrySample,
  ToolCall,
  VerifyReport,
} from "../domain/types.js";
import type { LedgerStore } from "../db/ledger-store.js";
import type { SimAction, SimState, SimStore } from "../db/sim-store.js";
import type { Store } from "../db/store.js";
import { HttpError } from "./errors.js";

export interface Actor {
  name: string;
  role: Role;
}

export interface OrchestratorDeps {
  ledger: LedgerStore;
  store: Store;
  sim: SimStore;
  agents: Agents;
  llmName: string;
  anchor: AnchorAdapter;
  approvals: ApprovalRail;
  payments: PaymentRail;
  identity: IdentityResolver;
  evidence: EvidenceStore;
  policy: Policy;
  policyHash: string;
  policyCheck?: () => Promise<{ ok: boolean; detail: string }>;
  seed: number;
  scenario: Scenario;
  tickMs: number;
  autonomy: AutonomyLevel;
  autostart: boolean;
  now?: () => number;
}

/** A run stops advancing after 12 plant hours, which bounds replay cost. */
export const MAX_MINUTE = 720;
const LEASE_MS = 90_000;
const SAMPLE_WINDOW_MIN = 60;
const WORK_ORDER_FEE = { low: 1, medium: 3, high: 5 } as const;
const iso = () => new Date().toISOString();
const shortId = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

interface Replay {
  key: string;
  plant: Plant;
  samples: TelemetrySample[];
  appliedIds: number[];
}

/**
 * Stateless orchestrator. Nothing about the plant lives in memory between requests: the plant is
 * replayed from durable state, so it runs the same on a long-lived server and on serverless
 * functions. `advance()` moves the plant to "now", logs failures, runs detection and drives
 * incidents; a lease guarantees only one caller does that at a time.
 */
export class Orchestrator {
  private cache: Replay | null = null;
  private names: Record<string, string | null> = {};
  private readonly now: () => number;

  constructor(private d: OrchestratorDeps) {
    this.now = d.now ?? Date.now;
  }

  async init(): Promise<void> {
    await this.d.sim.ensure({ scenario: this.d.scenario, seed: this.d.seed, startedAt: this.now(), tickMs: this.d.tickMs, pausedMinute: this.d.autostart ? null : 0 });
    this.names = await this.d.identity.names(["CNC-04", "CNC-05", "CNC-07", "LINE-02"]).catch(() => ({}));
  }

  async autonomy(): Promise<AutonomyLevel> {
    return (await this.d.store.setting<AutonomyLevel>("autonomy")) ?? this.d.autonomy;
  }

  // ---------------- Clock & replay ----------------
  minuteOf(s: SimState): number {
    const m = s.pausedMinute ?? Math.floor((this.now() - s.startedAt) / s.tickMs);
    return Math.max(0, Math.min(MAX_MINUTE, m));
  }

  /** Rebuild the plant at `minute`, reusing the cached replay when it is still a valid prefix. */
  private replay(s: SimState, actions: SimAction[], minute: number): Replay {
    const key = `${s.generation}:${s.seed}:${s.scenario}`;
    const c = this.cache;
    const valid =
      c !== null &&
      c.key === key &&
      c.plant.minute <= minute &&
      c.appliedIds.every((id, i) => actions[i]?.id === id) &&
      actions.slice(c.appliedIds.length).every((a) => a.minute >= c.plant.minute);
    const rep: Replay = valid ? c! : { key, plant: new Plant(s.seed, s.scenario), samples: [], appliedIds: [] };
    // Semantics: an action recorded at minute M is applied right after the plant's tick M.
    const applyDue = () => {
      for (const a of actions.slice(rep.appliedIds.length)) {
        if (a.minute !== rep.plant.minute) break;
        rep.plant.apply(a.action);
        rep.appliedIds.push(a.id);
      }
    };
    applyDue();
    while (rep.plant.minute < minute) {
      rep.samples.push(...rep.plant.tick());
      applyDue();
    }
    const cutoff = rep.plant.minute - SAMPLE_WINDOW_MIN;
    if (rep.samples.length && rep.samples[0]!.minute <= cutoff) rep.samples = rep.samples.filter((x) => x.minute > cutoff);
    this.cache = rep;
    return rep;
  }

  private async current(): Promise<{ s: SimState; rep: Replay }> {
    const s = await this.d.sim.get();
    const rep = this.replay(s, await this.d.sim.actions(s.generation), this.minuteOf(s));
    return { s, rep };
  }

  async view(): Promise<PlantView> {
    const { s, rep } = await this.current();
    const minute = this.minuteOf(s);
    return {
      minute,
      scenario: s.scenario,
      running: s.pausedMinute === null && minute < MAX_MINUTE,
      line: { id: rep.plant.lineId, name: rep.plant.lineName, autonomy: await this.autonomy(), speedPct: rep.plant.speedPct },
      assets: rep.plant.assetsView(this.names),
      batches: rep.plant.batchesView(),
      failures: [...rep.plant.failures],
      mode: { llm: this.d.llmName, anchor: this.d.anchor.kind, payments: this.d.payments.kind, identity: this.d.identity.kind },
    };
  }

  // ---------------- Simulator controls ----------------
  async reset(scenario: Scenario, seed = this.d.seed, actor = "system", start = true): Promise<void> {
    for (const i of await this.d.store.incidents(200)) if (i.status !== "closed") await this.forceClose(i, `Simulation reset to scenario "${scenario}".`);
    await this.d.sim.reset({ scenario, seed, startedAt: this.now(), tickMs: this.d.tickMs, pausedMinute: start ? null : 0 });
    this.cache = null;
    await this.append({ actor, type: "sim.reset", incidentId: null, payload: { scenario, seed } });
  }
  async pause(): Promise<void> {
    const s = await this.d.sim.get();
    if (s.pausedMinute === null) await this.d.sim.setClock(s.generation, s.startedAt, this.minuteOf(s));
  }
  async resume(): Promise<void> {
    const s = await this.d.sim.get();
    if (s.pausedMinute !== null) await this.d.sim.setClock(s.generation, this.now() - s.pausedMinute * s.tickMs, null);
  }
  /** Jump the plant clock forward (demo convenience). */
  async skip(minutes: number): Promise<void> {
    const s = await this.d.sim.get();
    if (s.pausedMinute !== null) await this.d.sim.setClock(s.generation, s.startedAt, Math.min(MAX_MINUTE, s.pausedMinute + minutes));
    else await this.d.sim.setClock(s.generation, s.startedAt - minutes * s.tickMs, null);
  }

  // ---------------- The engine step ----------------
  /** Bring the plant up to now and react to it. Safe to call from every request. */
  async advance(): Promise<{ advanced: boolean; minute: number }> {
    const peek = await this.d.sim.get();
    const target = this.minuteOf(peek);
    if (target <= peek.processedMinute) return { advanced: false, minute: target };
    const s = await this.d.sim.lease(this.now(), LEASE_MS);
    if (!s) return { advanced: false, minute: target }; // someone else is advancing
    let failuresLogged = s.failuresLogged;
    const minute = this.minuteOf(s);
    try {
      const rep = this.replay(s, await this.d.sim.actions(s.generation), minute);
      for (const f of rep.plant.failures.slice(failuresLogged)) {
        const open = await this.d.store.openIncidentFor(f.assetId);
        await this.append({ actor: "agent:line", type: "asset.failed", incidentId: open?.id ?? null, payload: { ...f, note: "Unplanned stop: bearing failure" } });
      }
      failuresLogged = rep.plant.failures.length;

      const suppressed = await this.d.sim.suppressed(s.generation);
      for (const asset of rep.plant.assets) {
        if (asset.status === "down" || asset.status === "maintenance") continue;
        const anomaly = detectAll(rep.samples.filter((x) => x.assetId === asset.id));
        if (!anomaly) {
          if (suppressed.has(asset.id)) await this.d.sim.unsuppress(s.generation, asset.id);
          continue;
        }
        if (suppressed.has(asset.id) || (await this.d.store.openIncidentFor(asset.id))) continue;
        const id = `INC-${String((await this.d.store.countIncidents()) + 1).padStart(4, "0")}`;
        await this.runIncident(id, anomaly, s).catch((e) => this.incidentError(id, e));
      }
    } finally {
      await this.d.sim.release(s.generation, minute, failuresLogged);
    }
    return { advanced: true, minute };
  }

  // ---------------- Ledger helpers ----------------
  private async append(draft: Omit<LedgerDraft, "ts">): Promise<LedgerEntry> {
    return this.d.ledger.append({ ...draft, ts: iso() });
  }

  async anchorHead(incidentId: string | null, evidence: string | null): Promise<void> {
    const head = await this.d.ledger.head();
    const last = (await this.d.store.anchors(1))[0];
    if (!head || (last && last.toSeq >= head.seq)) return;
    try {
      const ref = await this.d.anchor.anchor({ toSeq: head.seq, entryHash: head.entryHash, lineId: "LINE-02", incidentId, evidence });
      await this.d.store.saveAnchor({ kind: this.d.anchor.kind, toSeq: head.seq, entryHash: head.entryHash, ref: ref.ref, url: ref.url, ts: iso() }, { ...ref.data, incidentId, evidence });
    } catch (e) {
      await this.append({ actor: "system", type: "anchor.failed", incidentId, payload: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  private async decide(incidentId: string, agent: string, kind: DecisionKind, summary: string, data: unknown, ledgerType: string, extra: { confidence?: number | null; modelId?: string | null } = {}): Promise<Decision> {
    const entry = await this.append({ actor: agent, type: ledgerType, incidentId, payload: { summary, ...(data as object) } });
    const decision: Decision = { id: shortId("DEC"), incidentId, agent, kind, summary, data, confidence: extra.confidence ?? null, modelId: extra.modelId ?? null, ledgerSeq: entry.seq, ts: entry.ts };
    await this.d.store.saveDecision(decision);
    return decision;
  }

  // ---------------- The incident loop ----------------
  private async runIncident(id: string, anomaly: Anomaly, s: SimState): Promise<void> {
    const rep = this.cache!;
    const plant = rep.plant;
    const asset = plant.asset(anomaly.assetId);
    const unit = LIMITS[anomaly.signal]?.unit ?? "";
    const incident: Incident = {
      id,
      assetId: asset.id,
      lineId: plant.lineId,
      status: "open",
      severity: anomaly.level,
      title: `${anomaly.kind === "drift" ? "Drift" : "Limit breach"}: ${anomaly.signal} ${anomaly.value} ${unit} on ${asset.id}`,
      openedAt: iso(),
      closedAt: null,
      downtimeAvoidedMin: null,
    };
    await this.d.store.saveIncident(incident);
    await this.decide(id, "agent:line", "detect", incident.title, { anomaly, plantMinute: plant.minute }, "incident.opened", { confidence: 1 });

    const fc: Forecast = runForecast(rep.samples, asset.id, anomaly.signal);
    await this.decide(
      id,
      "agent:maintenance",
      "forecast",
      fc.ttfHours === null ? `No trend toward the ${fc.failureLimit} ${unit} limit` : `P(failure ≤ 24 h) ${Math.round(fc.pFailure24h * 100)}%, time to limit ${Math.round(fc.ttfHours * 60)} min`,
      { forecast: fc },
      "agent.forecast",
      { confidence: fc.confidence, modelId: fc.modelId },
    );

    const last30min = signalStats(rep.samples, asset.id);
    const diag = await this.d.agents.diagnose({ asset: { id: asset.id, status: asset.status }, anomaly, forecast: fc, last30min, limits: LIMITS });
    await this.decide(id, "agent:diagnosis", "diagnose", diag.value.rootCause, { diagnosis: diag.value, llm: llmMeta(diag) }, "agent.diagnosis", { confidence: diag.value.confidence, modelId: diag.modelId });

    const batch = plant.batchesView().find((b) => b.assetId === asset.id && (b.status === "running" || b.status === "blocked"));
    const available = plant.assetsView().filter((a) => a.id !== asset.id).map((a) => ({ id: a.id, status: a.status, vibration_rms: a.latest.vibration_rms?.value ?? null }));
    const rec = await this.d.agents.recommend({
      lineId: plant.lineId,
      asset: { id: asset.id, status: asset.status },
      anomaly,
      forecast: fc,
      diagnosis: { rootCause: diag.value.rootCause, confidence: diag.value.confidence },
      batchOnAsset: batch ? { id: batch.id, remainingUnits: remainingUnits(batch) } : null,
      availableAssets: available,
      lineSpeedPct: plant.speedPct,
      tools: TOOLS_DOC,
    });
    await this.decide(id, "agent:healer", "recommend", rec.value.reason, { recommendation: rec.value, grounding: rec.grounding, llm: llmMeta(rec) }, "agent.recommendation", { confidence: rec.value.confidence, modelId: rec.modelId });

    const level = await this.autonomy();
    const inputQuality = rep.samples.filter((x) => x.assetId === asset.id).slice(-20).map((x) => x.quality);
    const confidence = Math.min(rec.value.confidence, diag.value.confidence);
    for (const action of rec.value.actions) {
      const result = evaluate(action, { level, confidence, inputQuality, knownAssets: plant.assets.map((a) => a.id) }, this.d.policy, this.d.policyHash);
      await this.decide(id, "guard:policy", "guard", `${describe(action)} → ${result.outcome === "require_approval" ? `needs ${result.role?.replace("_", " ")}` : result.outcome}`, { action, policy: result, autonomy: level, confidence }, "policy.evaluated");
      if (result.outcome === "allow") await this.execute(incident, action, "agent:healer", null, s.generation, plant);
      else if (result.outcome === "block") await this.append({ actor: "guard:policy", type: "action.blocked", incidentId: id, payload: { action, ruleIds: result.ruleIds } });
      else {
        const approval: Approval = { id: shortId("APR"), incidentId: id, action, requiredRole: result.role ?? "operator", policy: result, status: "pending", actor: null, reason: null, externalRef: null, createdAt: iso(), resolvedAt: null };
        const ext = await this.d.approvals.request(approval).catch(async (e) => {
          await this.append({ actor: "system", type: "rail.error", incidentId: id, payload: { rail: "approvals", error: e instanceof Error ? e.message : String(e) } });
          return null;
        });
        approval.externalRef = ext?.ref ?? null;
        await this.d.store.saveApproval(approval);
        await this.append({ actor: "guard:policy", type: "approval.requested", incidentId: id, payload: { approvalId: approval.id, action, role: approval.requiredRole, externalRef: ext } });
      }
    }
    await this.settle(id, s.generation);
  }

  /** Apply an action to the plant now, record it durably so every replay sees it, pay for work orders. */
  private async execute(incident: Incident, action: ToolCall, actor: string, approvalId: string | null, generation: number, plant: Plant): Promise<void> {
    const effect = plant.apply(action);
    if (effect.ok) {
      const actionId = await this.d.sim.addAction(generation, plant.minute, action);
      if (this.cache?.plant === plant) this.cache.appliedIds.push(actionId);
    }
    await this.decide(incident.id, actor, "execute", effect.summary, { action, effect, approvalId, plantMinute: plant.minute }, effect.ok ? "action.executed" : "action.failed");
    if (effect.ok && action.tool === "open_work_order") {
      const head = await this.d.ledger.head();
      try {
        const ref = await this.d.payments.pay({ vendor: "vendor-acme", amount: WORK_ORDER_FEE[action.args.priority], memo: `ordo ${incident.id} WO ${action.args.assetId}`, incidentHash: head?.entryHash ?? "" });
        await this.append({ actor: "agent:healer", type: "payment.sent", incidentId: incident.id, payload: { vendor: "vendor-acme", amount: WORK_ORDER_FEE[action.args.priority], rail: this.d.payments.kind, ref } });
      } catch (e) {
        await this.append({ actor: "agent:healer", type: "payment.failed", incidentId: incident.id, payload: { error: e instanceof Error ? e.message : String(e) } });
      }
    }
  }

  private async settle(incidentId: string, generation: number): Promise<void> {
    const pending = (await this.d.store.approvals({ incidentId, status: "pending" })).length;
    const incident = (await this.d.store.incident(incidentId))!;
    if (pending > 0) {
      if (incident.status !== "awaiting_approval") await this.d.store.saveIncident({ ...incident, status: "awaiting_approval" });
      return;
    }
    await this.close(incident, generation);
  }

  private async close(incident: Incident, generation: number): Promise<void> {
    const decisions = await this.d.store.decisions(incident.id);
    const approvals = await this.d.store.approvals({ incidentId: incident.id });
    const fc = (decisions.find((x) => x.kind === "forecast")?.data as { forecast: Forecast } | undefined)?.forecast;
    const executed = decisions.filter((x) => x.kind === "execute" && (x.data as { effect: { ok: boolean } }).effect.ok);
    const workOrder = executed.some((x) => (x.data as { action: ToolCall }).action.tool === "open_work_order");
    const dt = workOrder ? downtimeAvoided({ pFailure: fc?.pFailure24h ?? 0, workOrderOpened: true }) : { minutes: 0, expectedUnplanned: 0, planned: 0 };

    const bundle = new TextEncoder().encode(canonicalize({ incident, decisions, approvals }));
    const ev = await this.d.evidence.put(bundle, `${incident.id}.json`).catch(() => null);
    if (ev) await this.append({ actor: "agent:compliance", type: "evidence.stored", incidentId: incident.id, payload: { store: this.d.evidence.kind, ...ev } });

    const entries = (await this.d.ledger.latest(200, incident.id)).reverse();
    const sum = await this.d.agents.summarize({ entries: entries.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, incidentId: e.incidentId, brief: brief(e) })) });
    await this.decide(incident.id, "agent:compliance", "summarize", sum.value.summary, { summary: sum.value, downtime: dt, executed: executed.length, llm: llmMeta(sum) }, "incident.closed", { modelId: sum.modelId });
    await this.d.store.saveIncident({ ...incident, status: "closed", closedAt: iso(), downtimeAvoidedMin: dt.minutes });
    await this.d.sim.suppress(generation, incident.assetId);
    await this.anchorHead(incident.id, ev?.uri ?? null);
  }

  private async forceClose(incident: Incident, reason: string) {
    for (const a of await this.d.store.approvals({ incidentId: incident.id, status: "pending" })) await this.d.store.saveApproval({ ...a, status: "expired", resolvedAt: iso() });
    await this.append({ actor: "system", type: "incident.closed", incidentId: incident.id, payload: { reason } });
    await this.d.store.saveIncident({ ...incident, status: "closed", closedAt: iso() });
  }

  private async incidentError(id: string, e: unknown) {
    await this.append({ actor: "system", type: "incident.error", incidentId: id, payload: { message: e instanceof Error ? e.message : String(e) } }).catch(() => undefined);
  }

  // ---------------- People ----------------
  async approve(approvalId: string, actor: Actor, reason?: string): Promise<Approval> {
    const a = await this.d.store.approval(approvalId);
    if (!a) throw new HttpError(404, "Approval not found");
    if (a.status !== "pending") throw new HttpError(409, `Approval is already ${a.status}`);
    if (!canApprove(actor.role, a.requiredRole)) throw new HttpError(403, `${actor.role} cannot approve; needs ${a.requiredRole}`);
    const incident = await this.d.store.incident(a.incidentId);
    if (!incident) throw new HttpError(404, "Incident not found");
    let ext: Awaited<ReturnType<ApprovalRail["confirm"]>> = null;
    if (a.externalRef) {
      // On-chain approval: the signature IS the approval. If it fails, nothing changes.
      ext = await this.d.approvals.confirm(a, actor.role).catch((e) => {
        throw new HttpError(502, `On-chain approval failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    const done: Approval = { ...a, status: "approved", actor: `${actor.name} (${actor.role})`, reason: reason ?? null, resolvedAt: iso() };
    await this.d.store.saveApproval(done);
    await this.append({ actor: `user:${actor.name}`, type: "approval.granted", incidentId: a.incidentId, payload: { approvalId, role: actor.role, reason: reason ?? null, action: a.action, externalRef: ext } });
    const { s, rep } = await this.current();
    await this.execute(incident, a.action, `user:${actor.name}`, approvalId, s.generation, rep.plant);
    await this.settle(a.incidentId, s.generation);
    return done;
  }

  async reject(approvalId: string, actor: Actor, reason: string): Promise<Approval> {
    if (!reason || reason.trim().length < 3) throw new HttpError(400, "A reason is required to reject");
    const a = await this.d.store.approval(approvalId);
    if (!a) throw new HttpError(404, "Approval not found");
    if (a.status !== "pending") throw new HttpError(409, `Approval is already ${a.status}`);
    if (!canApprove(actor.role, a.requiredRole)) throw new HttpError(403, `${actor.role} cannot decide; needs ${a.requiredRole}`);
    const done: Approval = { ...a, status: "rejected", actor: `${actor.name} (${actor.role})`, reason, resolvedAt: iso() };
    await this.d.store.saveApproval(done);
    await this.append({ actor: `user:${actor.name}`, type: "approval.rejected", incidentId: a.incidentId, payload: { approvalId, role: actor.role, reason, action: a.action } });
    const s = await this.d.sim.get();
    await this.settle(a.incidentId, s.generation);
    return done;
  }

  async setAutonomy(level: AutonomyLevel, actor: Actor): Promise<void> {
    if (actor.role !== "plant_manager") throw new HttpError(403, "Only the plant manager can change autonomy");
    const from = await this.autonomy();
    await this.d.store.setSetting("autonomy", level);
    await this.append({ actor: `user:${actor.name}`, type: "autonomy.changed", incidentId: null, payload: { from, to: level, policyVersion: this.d.policy.version } });
  }

  async shiftSummary(): Promise<{ summary: string; citedSeqs: number[]; seq: number }> {
    const entries = (await this.d.ledger.latest(80)).reverse();
    if (!entries.length) throw new HttpError(409, "Nothing in the ledger yet");
    const r = await this.d.agents.summarize({ entries: entries.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, incidentId: e.incidentId, brief: brief(e) })) });
    const entry = await this.append({ actor: "agent:compliance", type: "shift.summary", incidentId: null, payload: { ...r.value, llm: llmMeta(r) } });
    return { ...r.value, seq: entry.seq };
  }

  // ---------------- Verification ----------------
  async verify(incidentId: string, tamperSeq: number | null): Promise<VerifyReport> {
    const incident = await this.d.store.incident(incidentId);
    if (!incident) throw new HttpError(404, "Incident not found");
    const head = await this.d.ledger.head();
    const all = head ? await this.d.ledger.range(1, head.seq) : [];
    const chain = all.map((e) => (e.seq === tamperSeq ? { ...e, payload: { ...(e.payload as object), tampered: true } } : e));
    const { checks } = verifyChain(chain);
    const bySeq = new Map(checks.map((c) => [c.seq, c]));
    const mine = chain.filter((e) => e.incidentId === incidentId);
    const steps = mine.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, ok: bySeq.get(e.seq)?.ok ?? false, ...(bySeq.get(e.seq)?.reason ? { reason: bySeq.get(e.seq)!.reason } : {}) }));
    const maxSeq = Math.max(0, ...mine.map((e) => e.seq));
    const chainOk = checks.filter((c) => c.seq <= maxSeq).every((c) => c.ok);

    let anchor: VerifyReport["anchor"] = null;
    const covering = (await this.d.store.anchors(500)).filter((a) => a.toSeq >= maxSeq).sort((a, b) => a.toSeq - b.toSeq)[0];
    if (covering) {
      const sig = await this.d.anchor.verify({ toSeq: covering.toSeq, entryHash: covering.entryHash, ref: covering.ref, data: covering.data }).catch((e) => ({ ok: false, detail: String(e) }));
      const atSeq = chain.find((e) => e.seq === covering.toSeq);
      const matches = atSeq?.entryHash === covering.entryHash && checks.filter((c) => c.seq <= covering.toSeq).every((c) => c.ok);
      anchor = { ok: sig.ok && matches, kind: covering.kind, ref: covering.ref, url: covering.url, detail: !matches ? `Ledger no longer matches the hash anchored at #${covering.toSeq}` : sig.detail };
    }

    const used = mine.filter((e) => e.type === "policy.evaluated").map((e) => (e.payload as { policy: { policyHash: string } }).policy.policyHash);
    const ext = this.d.policyCheck ? await this.d.policyCheck().catch((e) => ({ ok: false, detail: String(e) })) : { ok: true, detail: "Policy file hash recorded with every guard decision" };
    const policyOk = used.every((h) => h === this.d.policyHash) && ext.ok;
    const policy = { ok: policyOk, version: this.d.policy.version, hash: this.d.policyHash, detail: policyOk ? ext.detail : `Policy mismatch: ${ext.detail}` };
    return { incidentId, ok: chainOk && (anchor?.ok ?? true) && policy.ok, chainOk, steps, anchor, policy, tamperedSeq: tamperSeq };
  }
}

function llmMeta(r: { provider: string; modelId: string; promptHash: string; inputHash: string; outputHash: string; latencyMs: number; fallback: boolean; error?: string }) {
  return { provider: r.provider, modelId: r.modelId, promptHash: r.promptHash, inputHash: r.inputHash, outputHash: r.outputHash, latencyMs: r.latencyMs, fallback: r.fallback, ...(r.error ? { error: r.error } : {}) };
}

export function describe(a: ToolCall): string {
  switch (a.tool) {
    case "reroute_batch":
      return `Reroute ${a.args.units} units of ${a.args.batchId} to ${a.args.targetAssetId}`;
    case "open_work_order":
      return `Work order on ${a.args.assetId} (${a.args.priority}) in ${a.args.windowMinutes} min`;
    case "adjust_line_speed":
      return `Line speed ${a.args.pctChange > 0 ? "+" : ""}${a.args.pctChange}%`;
    case "hold_gate":
      return `Hold ${a.args.batchId}`;
    case "request_inspection":
      return `Inspect ${a.args.assetId} at ${a.args.sampleRatePct}%`;
  }
}

export function brief(e: LedgerEntry | LedgerEntryDto): string {
  const p = e.payload as Record<string, unknown>;
  if (typeof p.summary === "string") return `${e.type}: ${p.summary}`.slice(0, 220);
  if (p.action) return `${e.type}: ${describe(p.action as ToolCall)}${p.role ? ` by ${String(p.role)}` : ""}`;
  return `${e.type}${p.reason ? `: ${String(p.reason)}` : ""}`.slice(0, 220);
}
