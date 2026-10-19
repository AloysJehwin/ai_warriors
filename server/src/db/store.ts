import type { AnchorDto, Approval, Decision, Incident } from "../domain/types.js";
import type { Db } from "./db.js";

const parse = <T>(rows: { data_json: string }[]): T[] => rows.map((r) => JSON.parse(r.data_json) as T);

export class Store {
  constructor(private db: Db) {}

  async countIncidents(): Promise<number> {
    const r = await this.db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM incidents");
    return Number(r.rows[0]?.n ?? 0);
  }
  async saveIncident(i: Incident): Promise<void> {
    await this.db.query(
      "INSERT INTO incidents (id, data_json, opened_at) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data_json = EXCLUDED.data_json",
      [i.id, JSON.stringify(i), i.openedAt],
    );
  }
  async incident(id: string): Promise<Incident | null> {
    return parse<Incident>((await this.db.query<{ data_json: string }>("SELECT data_json FROM incidents WHERE id = $1", [id])).rows)[0] ?? null;
  }
  async openIncidentFor(assetId: string): Promise<Incident | null> {
    return (await this.incidents(200)).find((i) => i.assetId === assetId && i.status !== "closed") ?? null;
  }
  async incidents(limit = 50): Promise<Incident[]> {
    return parse<Incident>((await this.db.query<{ data_json: string }>("SELECT data_json FROM incidents ORDER BY opened_at DESC LIMIT $1", [limit])).rows);
  }

  async saveDecision(d: Decision): Promise<void> {
    await this.db.query("INSERT INTO decisions (id, incident_id, data_json, ledger_seq) VALUES ($1,$2,$3,$4)", [d.id, d.incidentId, JSON.stringify(d), d.ledgerSeq]);
  }
  async decisions(incidentId: string): Promise<Decision[]> {
    return parse<Decision>((await this.db.query<{ data_json: string }>("SELECT data_json FROM decisions WHERE incident_id = $1 ORDER BY ledger_seq", [incidentId])).rows);
  }

  async decisionsAfter(seq: number, limit = 100): Promise<Decision[]> {
    return parse<Decision>((await this.db.query<{ data_json: string }>("SELECT data_json FROM decisions WHERE ledger_seq > $1 ORDER BY ledger_seq DESC LIMIT $2", [seq, limit])).rows);
  }
  async recentDecisions(limit = 40): Promise<Decision[]> {
    return parse<Decision>((await this.db.query<{ data_json: string }>("SELECT data_json FROM decisions ORDER BY ledger_seq DESC LIMIT $1", [limit])).rows);
  }

  async saveApproval(a: Approval): Promise<void> {
    await this.db.query(
      "INSERT INTO approvals (id, incident_id, status, data_json, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data_json = EXCLUDED.data_json",
      [a.id, a.incidentId, a.status, JSON.stringify(a), a.createdAt],
    );
  }
  async approval(id: string): Promise<Approval | null> {
    return parse<Approval>((await this.db.query<{ data_json: string }>("SELECT data_json FROM approvals WHERE id = $1", [id])).rows)[0] ?? null;
  }
  async approvals(filter: { status?: string; incidentId?: string } = {}): Promise<Approval[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) where.push(`status = $${params.push(filter.status)}`);
    if (filter.incidentId) where.push(`incident_id = $${params.push(filter.incidentId)}`);
    const sql = `SELECT data_json FROM approvals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 100`;
    return parse<Approval>((await this.db.query<{ data_json: string }>(sql, params)).rows);
  }

  async saveAnchor(a: Omit<AnchorDto, "id">, data: Record<string, unknown>): Promise<AnchorDto> {
    const r = await this.db.query<{ id: number }>(
      "INSERT INTO anchors (kind, to_seq, entry_hash, ref, url, data_json, ts) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [a.kind, a.toSeq, a.entryHash, a.ref, a.url, JSON.stringify(data), a.ts],
    );
    return { ...a, id: Number(r.rows[0]!.id) };
  }
  async anchors(limit = 50): Promise<(AnchorDto & { data: Record<string, unknown> })[]> {
    const r = await this.db.query<{ id: number; kind: string; to_seq: number; entry_hash: string; ref: string; url: string | null; data_json: string; ts: string }>(
      "SELECT * FROM anchors ORDER BY to_seq DESC LIMIT $1",
      [limit],
    );
    return r.rows.map((x) => ({ id: Number(x.id), kind: x.kind, toSeq: Number(x.to_seq), entryHash: x.entry_hash, ref: x.ref, url: x.url, ts: x.ts, data: JSON.parse(x.data_json) }));
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, JSON.stringify(value)]);
  }
  async setting<T>(key: string): Promise<T | null> {
    const r = await this.db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
    return r.rows[0] ? (JSON.parse(r.rows[0].value) as T) : null;
  }
}
