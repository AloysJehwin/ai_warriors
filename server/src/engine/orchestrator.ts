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
import type { Store } from "../db/store.js";
import type { Bus } from "./bus.js";
import { HttpError } from "./errors.js";

export interface Actor {
  name: string;
  role: Role;
}

export interface OrchestratorDeps {
  ledger: LedgerStore;
  store: Store;
  bus: Bus;
  agents: Agents;
  llmName: string;
  anchor: AnchorAdapter;
  approvals: ApprovalRail;
  payments: PaymentRail;
  identity: IdentityResolver;
  evidence: EvidenceStore;
  policy: Policy;
  policyHash: string;
  /** Optional external check that the policy in use is the published one (e.g. on-chain registry). */
  policyCheck?: () => Promise<{ ok: boolean; detail: string }>;
  seed: number;
  scenario: Scenario;
  tickMs: number;
  anchorEvery: number;
  autonomy: AutonomyLevel;
}

const SAMPLE_WINDOW = 240 * 4; // ~4 plant hours across all assets
const WORK_ORDER_FEE = { low: 1, medium: 3, high: 5 } as const; // HBAR (testnet) or credits
const now = () => new Date().toISOString();
const shortId = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

export class Orchestrator {
  plant: Plant;
  autonomy: AutonomyLevel;
  private samples: TelemetrySample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private openByAsset = new Map<string, string>();
  private suppressed = new Set<string>();
  private inflight = new Set<Promise<unknown>>();
  private incidentCounter = 0;
  private failuresSeen = 0;
  private lastAnchoredSeq = 0;
  private anchoring: Promise<unknown> = Promise.resolve();
  private names: Record<string, string | null> = {};

  constructor(private d: OrchestratorDeps) {
    this.plant = new Plant(d.seed, d.scenario);
    this.autonomy = d.autonomy;
  }

  async init(): Promise<void> {
    this.incidentCounter = await this.d.store.countIncidents();
    this.autonomy = (await this.d.store.setting<AutonomyLevel>("autonomy")) ?? this.autonomy;
    this.lastAnchoredSeq = (await this.d.store.anchors(1))[0]?.toSeq ?? 0;
    // Close anything left open by a previous process: the simulated plant does not survive restarts.
    for (const i of await this.d.store.incidents(200)) if (i.status !== "closed") await this.forceClose(i, "Process restarted; simulated plant state was reset.");
    for (const a of await this.d.store.approvals({ status: "pending" })) await this.d.store.saveApproval({ ...a, status: "expired", resolvedAt: now() });
    this.names = await this.d.identity.names([...this.plant.assets.map((a) => a.id), "LINE-02"]).catch(() => ({}));
  }

  get running(): boolean {
    return this.timer !== null;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), this.d.tickMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wait until all in-flight incident work has finished (used by tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    await this.anchoring;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  async reset(scenario: Scenario, seed = this.d.seed, actor = "system"): Promise<void> {
    const wasRunning = this.running;
    this.stop();
    await this.idle();
    for (const id of new Set(this.openByAsset.values())) {
      const inc = await this.d.store.incident(id);
      if (inc) await this.forceClose(inc, `Simulation reset to scenario "${scenario}".`);
    }
    this.plant = new Plant(seed, scenario);
    this.samples = [];
    this.openByAsset.clear();
    this.suppressed.clear();
    this.failuresSeen = 0;
    await this.append({ actor, type: "sim.reset", incidentId: null, payload: { scenario, seed } });
    this.emitPlant();
    if (wasRunning || scenario !== "normal") this.start();
  }

  /** One plant minute: telemetry, failure check, detection. Never awaits; incident work runs async. */
  step(): void {
    const fresh = this.plant.tick();
    this.samples.push(...fresh);
    if (this.samples.length > SAMPLE_WINDOW) this.samples.splice(0, this.samples.length - SAMPLE_WINDOW);

    if (this.plant.failures.length > this.failuresSeen) {
      for (const f of this.plant.failures.slice(this.failuresSeen))
        this.track(this.append({ actor: "agent:line", type: "asset.failed", incidentId: this.openByAsset.get(f.assetId) ?? null, payload: { ...f, note: "Unplanned stop: bearing failure" } }));
      this.failuresSeen = this.plant.failures.length;
      this.d.bus.emit({ type: "alert", level: "warn", message: `Unplanned failure on ${this.plant.failures.at(-1)!.assetId}` });
    }

    for (const asset of this.plant.assets) {
      if (asset.status === "down" || asset.status === "maintenance") continue;
      const mine = this.samples.filter((s) => s.assetId === asset.id);
      const anomaly = detectAll(mine);
      if (!anomaly) {
        this.suppressed.delete(asset.id);
        continue;
      }
      if (this.openByAsset.has(asset.id) || this.suppressed.has(asset.id)) continue;
      const incidentId = `INC-${String(++this.incidentCounter).padStart(4, "0")}`;
      this.openByAsset.set(asset.id, incidentId);
      this.track(this.runIncident(incidentId, anomaly).catch((e) => this.incidentError(incidentId, e)));
    }
    this.emitPlant();
  }

  view(): PlantView {
    return {
      minute: this.plant.minute,
      scenario: this.plant.scenario,
      running: this.running,
      line: { id: this.plant.lineId, name: this.plant.lineName, autonomy: this.autonomy, speedPct: this.plant.speedPct },
      assets: this.plant.assetsView(this.names),
      batches: this.plant.batchesView(),
      failures: [...this.plant.failures],
      mode: { llm: this.d.llmName, anchor: this.d.anchor.kind, payments: this.d.payments.kind, identity: this.d.identity.kind },
    };
  }
  private emitPlant() {
    this.d.bus.emit({ type: "plant.tick", plant: this.view() });
  }

  // ---------------- Ledger helpers ----------------
  private async append(draft: Omit<LedgerDraft, "ts">): Promise<LedgerEntry> {
    const e = await this.d.ledger.append({ ...draft, ts: now() });
    this.d.bus.emit({ type: "ledger.appended", entry: e });
    if (e.seq - this.lastAnchoredSeq >= this.d.anchorEvery) this.scheduleAnchor(draft.incidentId, null);
    return e;
  }

  private scheduleAnchor(incidentId: string | null, evidence: string | null): Promise<unknown> {
    const run = async () => {
      const head = await this.d.ledger.head();
      if (!head || head.seq <= this.lastAnchoredSeq) return;
      this.lastAnchoredSeq = head.seq;
      try {
        const ref = await this.d.anchor.anchor({ toSeq: head.seq, entryHash: head.entryHash, lineId: this.plant.lineId, incidentId, evidence });
        const saved = await this.d.store.saveAnchor(
          { kind: this.d.anchor.kind, toSeq: head.seq, entryHash: head.entryHash, ref: ref.ref, url: ref.url, ts: now() },
          { ...ref.data, incidentId, evidence },
        );
        this.d.bus.emit({ type: "anchor.recorded", anchor: saved });
      } catch (e) {
        this.lastAnchoredSeq = 0;
        this.d.bus.emit({ type: "alert", level: "warn", message: `Anchor failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    };
    this.anchoring = this.anchoring.then(run, run);
    return this.anchoring;
  }

  private async decide(incidentId: string, agent: string, kind: DecisionKind, summary: string, data: unknown, ledgerType: string, extra: { confidence?: number | null; modelId?: string | null } = {}): Promise<Decision> {
    const entry = await this.append({ actor: agent, type: ledgerType, incidentId, payload: { summary, ...(data as object) } });
    const decision: Decision = {
      id: shortId("DEC"),
      incidentId,
      agent,
      kind,
      summary,
      data,
      confidence: extra.confidence ?? null,
      modelId: extra.modelId ?? null,
      ledgerSeq: entry.seq,
      ts: entry.ts,
    };
    await this.d.store.saveDecision(decision);
    this.d.bus.emit({ type: "decision.recorded", decision });
    return decision;
  }

  private async saveIncident(i: Incident) {
    await this.d.store.saveIncident(i);
    this.d.bus.emit({ type: "incident.updated", incident: i });
  }

  // ---------------- The incident loop ----------------
  private async runIncident(id: string, anomaly: Anomaly): Promise<void> {
    const asset = this.plant.asset(anomaly.assetId);
    const unit = LIMITS[anomaly.signal]?.unit ?? "";
    const incident: Incident = {
      id,
      assetId: asset.id,
      lineId: this.plant.lineId,
      status: "open",
      severity: anomaly.level,
      title: `${anomaly.kind === "drift" ? "Drift" : "Limit breach"}: ${anomaly.signal} ${anomaly.value} ${unit} on ${asset.id}`,
      openedAt: now(),
      closedAt: null,
      downtimeAvoidedMin: null,
    };
    await this.saveIncident(incident);
    await this.decide(id, "agent:line", "detect", incident.title, { anomaly }, "incident.opened", { confidence: 1 });

    // 2. Forecast
    const fc: Forecast = runForecast(this.samples, asset.id, anomaly.signal);
    await this.decide(
      id,
      "agent:maintenance",
      "forecast",
      fc.ttfHours === null ? `No trend toward the ${fc.failureLimit} ${unit} limit` : `P(failure ≤ 24 h) ${Math.round(fc.pFailure24h * 100)}%, time to limit ${Math.round(fc.ttfHours * 60)} min`,
      { forecast: fc },
      "agent.forecast",
      { confidence: fc.confidence, modelId: fc.modelId },
    );

    // 3. Diagnosis (LLM)
    const last30min = signalStats(this.samples, asset.id);
    const diag = await this.d.agents.diagnose({ asset: { id: asset.id, status: asset.status }, anomaly, forecast: fc, last30min, limits: LIMITS });
    await this.decide(id, "agent:diagnosis", "diagnose", diag.value.rootCause, { diagnosis: diag.value, llm: llmMeta(diag) }, "agent.diagnosis", {
      confidence: diag.value.confidence,
      modelId: diag.modelId,
    });

    // 4. Recommendation (LLM tool selection)
    const batch = this.plant.batchesView().find((b) => b.assetId === asset.id && (b.status === "running" || b.status === "blocked"));
    const available = this.plant.assetsView().filter((a) => a.id !== asset.id).map((a) => ({ id: a.id, status: a.status, vibration_rms: a.latest.vibration_rms?.value ?? null }));
    const rec = await this.d.agents.recommend({
      lineId: this.plant.lineId,
      asset: { id: asset.id, status: asset.status },
      anomaly,
      forecast: fc,
      diagnosis: { rootCause: diag.value.rootCause, confidence: diag.value.confidence },
      batchOnAsset: batch ? { id: batch.id, remainingUnits: remainingUnits(batch) } : null,
      availableAssets: available,
      lineSpeedPct: this.plant.speedPct,
      tools: TOOLS_DOC,
    });
    await this.decide(id, "agent:healer", "recommend", rec.value.reason, { recommendation: rec.value, grounding: rec.grounding, llm: llmMeta(rec) }, "agent.recommendation", {
      confidence: rec.value.confidence,
      modelId: rec.modelId,
    });

    // 5. Policy guard per action → execute, ask for approval, or block
    const inputQuality = this.samples.filter((s) => s.assetId === asset.id).slice(-20).map((s) => s.quality);
    const confidence = Math.min(rec.value.confidence, diag.value.confidence);
    for (const action of rec.value.actions) {
      const result = evaluate(action, { level: this.autonomy, confidence, inputQuality, knownAssets: this.plant.assets.map((a) => a.id) }, this.d.policy, this.d.policyHash);
      const label = describe(action);
      await this.decide(
        id,
        "guard:policy",
        "guard",
        `${label} → ${result.outcome === "require_approval" ? `needs ${result.role?.replace("_", " ")}` : result.outcome}`,
        { action, policy: result, autonomy: this.autonomy, confidence },
        "policy.evaluated",
      );
      if (result.outcome === "allow") await this.execute(incident, action, "agent:healer", null);
      else if (result.outcome === "block") await this.append({ actor: "guard:policy", type: "action.blocked", incidentId: id, payload: { action, ruleIds: result.ruleIds } });
      else {
        const approval: Approval = {
          id: shortId("APR"),
          incidentId: id,
          action,
          requiredRole: result.role ?? "operator",
          policy: result,
          status: "pending",
          actor: null,
          reason: null,
          externalRef: null,
          createdAt: now(),
          resolvedAt: null,
        };
        const ext = await this.d.approvals.request(approval).catch((e) => {
          this.d.bus.emit({ type: "alert", level: "warn", message: `Approval rail: ${e instanceof Error ? e.message : String(e)}` });
          return null;
        });
        approval.externalRef = ext?.ref ?? null;
        await this.d.store.saveApproval(approval);
        await this.append({ actor: "guard:policy", type: "approval.requested", incidentId: id, payload: { approvalId: approval.id, action, role: approval.requiredRole, externalRef: ext } });
        this.d.bus.emit({ type: "approval.updated", approval });
      }
    }
    await this.settle(id);
  }

  private async execute(incident: Incident, action: ToolCall, actor: string, approvalId: string | null): Promise<void> {
    const effect = this.plant.apply(action);
    await this.decide(incident.id, actor, "execute", effect.summary, { action, effect, approvalId }, effect.ok ? "action.executed" : "action.failed");
    if (effect.ok && action.tool === "open_work_order") {
      const head = await this.d.ledger.head();
      try {
        const ref = await this.d.payments.pay({
          vendor: "vendor-acme",
          amount: WORK_ORDER_FEE[action.args.priority],
          memo: `ordo ${incident.id} WO ${action.args.assetId}`,
          incidentHash: head?.entryHash ?? "",
        });
        await this.append({ actor: "agent:healer", type: "payment.sent", incidentId: incident.id, payload: { vendor: "vendor-acme", amount: WORK_ORDER_FEE[action.args.priority], rail: this.d.payments.kind, ref } });
      } catch (e) {
        await this.append({ actor: "agent:healer", type: "payment.failed", incidentId: incident.id, payload: { error: e instanceof Error ? e.message : String(e) } });
      }
    }
    this.emitPlant();
  }

  /** Close the incident once nothing is pending. */
  private async settle(incidentId: string): Promise<void> {
    const pending = (await this.d.store.approvals({ incidentId, status: "pending" })).length;
    const incident = (await this.d.store.incident(incidentId))!;
    if (pending > 0) {
      if (incident.status !== "awaiting_approval") await this.saveIncident({ ...incident, status: "awaiting_approval" });
      return;
    }
    await this.close(incident);
  }

  private async close(incident: Incident): Promise<void> {
    const decisions = await this.d.store.decisions(incident.id);
    const approvals = await this.d.store.approvals({ incidentId: incident.id });
    const fc = (decisions.find((x) => x.kind === "forecast")?.data as { forecast: Forecast } | undefined)?.forecast;
    const executed = decisions.filter((x) => x.kind === "execute" && (x.data as { effect: { ok: boolean } }).effect.ok);
    const workOrder = executed.some((x) => (x.data as { action: ToolCall }).action.tool === "open_work_order");
    const dt = workOrder ? downtimeAvoided({ pFailure: fc?.pFailure24h ?? 0, workOrderOpened: true }) : { minutes: 0, expectedUnplanned: 0, planned: 0 };

    // Evidence bundle → evidence store (content-addressed).
    const bundle = new TextEncoder().encode(canonicalize({ incident, decisions, approvals }));
    const ev = await this.d.evidence.put(bundle, `${incident.id}.json`).catch(() => null);
    if (ev) await this.append({ actor: "agent:compliance", type: "evidence.stored", incidentId: incident.id, payload: { store: this.d.evidence.kind, ...ev } });

    const entries = await this.d.ledger.latest(200, incident.id);
    const sum = await this.d.agents.summarize({ entries: entries.reverse().map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, incidentId: e.incidentId, brief: brief(e) })) });
    const closed: Incident = { ...incident, status: "closed", closedAt: now(), downtimeAvoidedMin: dt.minutes };
    await this.decide(incident.id, "agent:compliance", "summarize", sum.value.summary, { summary: sum.value, downtime: dt, executed: executed.length, llm: llmMeta(sum) }, "incident.closed", { modelId: sum.modelId });
    await this.saveIncident(closed);
    if (this.openByAsset.get(incident.assetId) === incident.id) {
      this.openByAsset.delete(incident.assetId);
      this.suppressed.add(incident.assetId);
    }
    await this.scheduleAnchor(incident.id, ev?.uri ?? null);
  }

  private async forceClose(incident: Incident, reason: string) {
    for (const a of await this.d.store.approvals({ incidentId: incident.id, status: "pending" })) {
      const expired = { ...a, status: "expired" as const, resolvedAt: now() };
      await this.d.store.saveApproval(expired);
      this.d.bus.emit({ type: "approval.updated", approval: expired });
    }
    await this.append({ actor: "system", type: "incident.closed", incidentId: incident.id, payload: { reason } });
    await this.saveIncident({ ...incident, status: "closed", closedAt: now() });
  }

  private async incidentError(id: string, e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await this.append({ actor: "system", type: "incident.error", incidentId: id, payload: { message } }).catch(() => undefined);
    this.d.bus.emit({ type: "alert", level: "warn", message: `${id}: ${message}` });
  }

  // ---------------- People ----------------
  async approve(approvalId: string, actor: Actor, reason?: string): Promise<Approval> {
    const a = await this.d.store.approval(approvalId);
    if (!a) throw new HttpError(404, "Approval not found");
    if (a.status !== "pending") throw new HttpError(409, `Approval is already ${a.status}`);
    if (!canApprove(actor.role, a.requiredRole)) throw new HttpError(403, `${actor.role} cannot approve; needs ${a.requiredRole}`);
    const incident = await this.d.store.incident(a.incidentId);
    if (!incident) throw new HttpError(404, "Incident not found");
    // Claim it first so a double click cannot execute twice.
    const done: Approval = { ...a, status: "approved", actor: `${actor.name} (${actor.role})`, reason: reason ?? null, resolvedAt: now() };
    await this.d.store.saveApproval(done);
    const ext = await this.d.approvals.confirm(a, actor.role).catch((e) => {
      this.d.bus.emit({ type: "alert", level: "warn", message: `Approval signature: ${e instanceof Error ? e.message : String(e)}` });
      return null;
    });
    await this.append({ actor: `user:${actor.name}`, type: "approval.granted", incidentId: a.incidentId, payload: { approvalId, role: actor.role, reason: reason ?? null, action: a.action, externalRef: ext } });
    this.d.bus.emit({ type: "approval.updated", approval: done });
    await this.track(this.execute(incident, a.action, `user:${actor.name}`, approvalId));
    await this.track(this.settle(a.incidentId));
    return done;
  }

  async reject(approvalId: string, actor: Actor, reason: string): Promise<Approval> {
    if (!reason || reason.trim().length < 3) throw new HttpError(400, "A reason is required to reject");
    const a = await this.d.store.approval(approvalId);
    if (!a) throw new HttpError(404, "Approval not found");
    if (a.status !== "pending") throw new HttpError(409, `Approval is already ${a.status}`);
    if (!canApprove(actor.role, a.requiredRole)) throw new HttpError(403, `${actor.role} cannot decide; needs ${a.requiredRole}`);
    const done: Approval = { ...a, status: "rejected", actor: `${actor.name} (${actor.role})`, reason, resolvedAt: now() };
    await this.d.store.saveApproval(done);
    await this.append({ actor: `user:${actor.name}`, type: "approval.rejected", incidentId: a.incidentId, payload: { approvalId, role: actor.role, reason, action: a.action } });
    this.d.bus.emit({ type: "approval.updated", approval: done });
    await this.track(this.settle(a.incidentId));
    return done;
  }

  async setAutonomy(level: AutonomyLevel, actor: Actor): Promise<void> {
    if (actor.role !== "plant_manager") throw new HttpError(403, "Only the plant manager can change autonomy");
    const from = this.autonomy;
    this.autonomy = level;
    await this.d.store.setSetting("autonomy", level);
    await this.append({ actor: `user:${actor.name}`, type: "autonomy.changed", incidentId: null, payload: { from, to: level, policyVersion: this.d.policy.version } });
    this.emitPlant();
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
      const upToOk = checks.filter((c) => c.seq <= covering.toSeq).every((c) => c.ok);
      const matches = atSeq?.entryHash === covering.entryHash && upToOk;
      anchor = {
        ok: sig.ok && matches,
        kind: covering.kind,
        ref: covering.ref,
        url: covering.url,
        detail: !matches ? `Ledger no longer matches the hash anchored at #${covering.toSeq}` : sig.detail,
      };
    }

    const decisionsPolicy = mine.filter((e) => e.type === "policy.evaluated").map((e) => (e.payload as { policy: { policyHash: string } }).policy.policyHash);
    const ext = this.d.policyCheck ? await this.d.policyCheck().catch((e) => ({ ok: false, detail: String(e) })) : { ok: true, detail: "Policy file hash recorded with every guard decision" };
    const policyOk = decisionsPolicy.every((h) => h === this.d.policyHash) && ext.ok;
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
