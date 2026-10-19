import { mkdirSync } from "node:fs";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "pglite" | "postgres";
}

/** Postgres when DATABASE_URL is set; otherwise embedded Postgres (PGlite) on disk or in memory. */
export async function openDb(opts: { url?: string; dataDir?: string }): Promise<Db> {
  if (opts.url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: opts.url, max: 5 });
    return {
      kind: "postgres",
      query: async (sql, params) => pool.query(sql, params as unknown[]) as never,
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const out = await fn({ query: async (s, p) => client.query(s, p as unknown[]) as never });
          await client.query("COMMIT");
          return out;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = opts.dataDir && opts.dataDir !== "memory" ? `${opts.dataDir}/pg` : undefined;
  if (dir) mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: "pglite",
    query: async (sql, params) => db.query(sql, params as unknown[]) as never,
    tx: async (fn) => db.transaction(async (t) => fn({ query: async (s, p) => t.query(s, p as unknown[]) as never })),
    close: () => db.close(),
  };
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  seq          INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  type         TEXT NOT NULL,
  incident_id  TEXT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  entry_hash   TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ledger_incident ON ledger (incident_id);
CREATE TABLE IF NOT EXISTS anchors (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  to_seq     INTEGER NOT NULL,
  entry_hash TEXT NOT NULL,
  ref        TEXT NOT NULL,
  url        TEXT,
  data_json  TEXT NOT NULL,
  ts         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  id         TEXT PRIMARY KEY,
  data_json  TEXT NOT NULL,
  opened_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  ledger_seq  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_incident ON decisions (incident_id);
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  status      TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_state (
  id               INTEGER PRIMARY KEY,
  generation       INTEGER NOT NULL,
  scenario         TEXT NOT NULL,
  seed             INTEGER NOT NULL,
  started_at       BIGINT NOT NULL,
  tick_ms          INTEGER NOT NULL,
  paused_minute    INTEGER,
  processed_minute INTEGER NOT NULL,
  failures_logged  INTEGER NOT NULL,
  lease_until      BIGINT
);
CREATE TABLE IF NOT EXISTS sim_actions (
  id          SERIAL PRIMARY KEY,
  generation  INTEGER NOT NULL,
  minute      INTEGER NOT NULL,
  action_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_suppressed (
  generation INTEGER NOT NULL,
  asset_id   TEXT NOT NULL,
  PRIMARY KEY (generation, asset_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export async function migrate(db: Db): Promise<void> {
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
}
