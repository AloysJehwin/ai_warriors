import type { Scenario } from "../domain/simulator.js";
import type { ToolCall } from "../domain/types.js";
import type { Db } from "./db.js";

export interface SimState {
  generation: number;
  scenario: Scenario;
  seed: number;
  startedAt: number;
  tickMs: number;
  pausedMinute: number | null;
  processedMinute: number;
  failuresLogged: number;
}
export interface SimAction {
  id: number;
  minute: number;
  action: ToolCall;
}

interface Row {
  generation: number;
  scenario: string;
  seed: number;
  started_at: string | number;
  tick_ms: number;
  paused_minute: number | null;
  processed_minute: number;
  failures_logged: number;
}
const toState = (r: Row): SimState => ({
  generation: Number(r.generation),
  scenario: r.scenario as Scenario,
  seed: Number(r.seed),
  startedAt: Number(r.started_at),
  tickMs: Number(r.tick_ms),
  pausedMinute: r.paused_minute === null ? null : Number(r.paused_minute),
  processedMinute: Number(r.processed_minute),
  failuresLogged: Number(r.failures_logged),
});

/**
 * Durable simulator state. The plant itself is never stored: it is replayed deterministically
 * from (seed, scenario, elapsed minutes, executed actions), so any stateless instance can serve it.
 */
export class SimStore {
  constructor(private db: Db) {}

  async ensure(init: Omit<SimState, "generation" | "processedMinute" | "failuresLogged">): Promise<SimState> {
    await this.db.query(
      `INSERT INTO sim_state (id, generation, scenario, seed, started_at, tick_ms, paused_minute, processed_minute, failures_logged)
       VALUES (1, 1, $1, $2, $3, $4, $5, 0, 0) ON CONFLICT (id) DO NOTHING`,
      [init.scenario, init.seed, init.startedAt, init.tickMs, init.pausedMinute],
    );
    return this.get();
  }

  async get(): Promise<SimState> {
    const r = await this.db.query<Row>("SELECT * FROM sim_state WHERE id = 1");
    if (!r.rows[0]) throw new Error("simulator state missing");
    return toState(r.rows[0]);
  }

  /** Start a new run: new generation, fresh clock, no actions, nothing suppressed. */
  async reset(s: { scenario: Scenario; seed: number; startedAt: number; tickMs: number; pausedMinute: number | null }): Promise<SimState> {
    await this.db.query(
      `UPDATE sim_state SET generation = generation + 1, scenario = $1, seed = $2, started_at = $3, tick_ms = $4,
         paused_minute = $5, processed_minute = 0, failures_logged = 0, lease_until = NULL WHERE id = 1`,
      [s.scenario, s.seed, s.startedAt, s.tickMs, s.pausedMinute],
    );
    return this.get();
  }

  async setClock(generation: number, startedAt: number, pausedMinute: number | null): Promise<void> {
    await this.db.query("UPDATE sim_state SET started_at = $1, paused_minute = $2 WHERE id = 1 AND generation = $3", [startedAt, pausedMinute, generation]);
  }

  /** Take the processing lease. Only one instance advances the plant at a time. */
  async lease(now: number, ms: number): Promise<SimState | null> {
    const r = await this.db.query<Row>(
      "UPDATE sim_state SET lease_until = $1 WHERE id = 1 AND (lease_until IS NULL OR lease_until < $2) RETURNING *",
      [now + ms, now],
    );
    return r.rows[0] ? toState(r.rows[0]) : null;
  }

  async release(generation: number, processedMinute: number, failuresLogged: number): Promise<void> {
    await this.db.query("UPDATE sim_state SET processed_minute = $1, failures_logged = $2 WHERE id = 1 AND generation = $3", [processedMinute, failuresLogged, generation]);
    await this.db.query("UPDATE sim_state SET lease_until = NULL WHERE id = 1");
  }

  async actions(generation: number): Promise<SimAction[]> {
    const r = await this.db.query<{ id: number; minute: number; action_json: string }>("SELECT id, minute, action_json FROM sim_actions WHERE generation = $1 ORDER BY id", [generation]);
    return r.rows.map((x) => ({ id: Number(x.id), minute: Number(x.minute), action: JSON.parse(x.action_json) as ToolCall }));
  }

  async addAction(generation: number, minute: number, action: ToolCall): Promise<number> {
    const r = await this.db.query<{ id: number }>("INSERT INTO sim_actions (generation, minute, action_json) VALUES ($1, $2, $3) RETURNING id", [generation, minute, JSON.stringify(action)]);
    return Number(r.rows[0]!.id);
  }

  async suppressed(generation: number): Promise<Set<string>> {
    const r = await this.db.query<{ asset_id: string }>("SELECT asset_id FROM sim_suppressed WHERE generation = $1", [generation]);
    return new Set(r.rows.map((x) => x.asset_id));
  }
  async suppress(generation: number, assetId: string): Promise<void> {
    await this.db.query("INSERT INTO sim_suppressed (generation, asset_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [generation, assetId]);
  }
  async unsuppress(generation: number, assetId: string): Promise<void> {
    await this.db.query("DELETE FROM sim_suppressed WHERE generation = $1 AND asset_id = $2", [generation, assetId]);
  }
}
