import { describe, expect, it } from "vitest";
import { migrate, openDb } from "../../src/db/db.js";

describe("migrations", () => {
  it("creates the v2 schema on an empty database and is idempotent", async () => {
    const db = await openDb({ dataDir: "memory" });
    expect(await migrate(db)).toBe(9);
    expect(await migrate(db)).toBe(0);
    const t = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const names = t.rows.map((r) => r.table_name);
    for (const n of ["users", "sessions", "sites", "memberships", "assets", "telemetry", "templates", "runs", "stage_runs", "inbox_items", "validation_packages", "signatures", "ledger", "package_signatures", "blobs"]) expect(names).toContain(n);
    await db.close();
  });

  it("upgrades a v1 demo database and archives its ledger", async () => {
    const db = await openDb({ dataDir: "memory" });
    await db.query("CREATE TABLE ledger (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, incident_id TEXT, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL UNIQUE)");
    await db.query("CREATE TABLE anchors (id SERIAL PRIMARY KEY, kind TEXT NOT NULL, to_seq INTEGER NOT NULL, entry_hash TEXT NOT NULL, ref TEXT NOT NULL, url TEXT, data_json TEXT NOT NULL, ts TEXT NOT NULL)");
    await db.query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await db.query("INSERT INTO ledger VALUES (1,'t','a','sim.reset',null,'{}','h','p','e')");
    expect(await migrate(db)).toBe(8);
    expect((await db.query<{ n: string }>("SELECT COUNT(*)::text n FROM ledger_v1_demo")).rows[0]!.n).toBe("1");
    expect((await db.query<{ n: string }>("SELECT COUNT(*)::text n FROM ledger")).rows[0]!.n).toBe("0");
    await db.close();
  });
});
