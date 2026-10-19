import { canonicalize } from "../domain/canonical.js";
import { buildEntry, type LedgerDraft, type LedgerEntry } from "../domain/ledger.js";
import type { Db } from "./db.js";

interface Row {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  incident_id: string | null;
  payload_json: string;
  payload_hash: string;
  prev_hash: string;
  entry_hash: string;
}
const toEntry = (r: Row): LedgerEntry => ({
  seq: Number(r.seq),
  ts: r.ts,
  actor: r.actor,
  type: r.type,
  incidentId: r.incident_id,
  payload: JSON.parse(r.payload_json),
  payloadHash: r.payload_hash,
  prevHash: r.prev_hash,
  entryHash: r.entry_hash,
});

const LEDGER_LOCK = 4242;

/**
 * Single-writer ledger. Appends are serialized in-process (promise chain) and in Postgres
 * (transaction-scoped advisory lock), so two appends can never fork the chain.
 */
export class LedgerStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private db: Db) {}

  append(draft: LedgerDraft): Promise<LedgerEntry> {
    const run = async () =>
      this.db.tx(async (q) => {
        if (this.db.kind === "postgres") await q.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_LOCK]);
        const last = await q.query<{ seq: number; entry_hash: string }>("SELECT seq, entry_hash FROM ledger ORDER BY seq DESC LIMIT 1");
        const prev = last.rows[0] ? { seq: Number(last.rows[0].seq), entryHash: last.rows[0].entry_hash } : null;
        // Store the canonical form so the payload reads back byte-identical.
        const payload = JSON.parse(canonicalize(draft.payload));
        const e = buildEntry(prev, { ...draft, payload });
        await q.query(
          "INSERT INTO ledger (seq, ts, actor, type, incident_id, payload_json, payload_hash, prev_hash, entry_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [e.seq, e.ts, e.actor, e.type, e.incidentId, canonicalize(payload), e.payloadHash, e.prevHash, e.entryHash],
        );
        return e;
      });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async range(fromSeq: number, toSeq: number): Promise<LedgerEntry[]> {
    const r = await this.db.query<Row>("SELECT * FROM ledger WHERE seq >= $1 AND seq <= $2 ORDER BY seq", [fromSeq, toSeq]);
    return r.rows.map(toEntry);
  }

  async latest(limit: number, incidentId?: string): Promise<LedgerEntry[]> {
    const r = incidentId
      ? await this.db.query<Row>("SELECT * FROM ledger WHERE incident_id = $1 ORDER BY seq DESC LIMIT $2", [incidentId, limit])
      : await this.db.query<Row>("SELECT * FROM ledger ORDER BY seq DESC LIMIT $1", [limit]);
    return r.rows.map(toEntry);
  }

  async after(seq: number, limit = 200): Promise<LedgerEntry[]> {
    const r = await this.db.query<Row>("SELECT * FROM ledger WHERE seq > $1 ORDER BY seq DESC LIMIT $2", [seq, limit]);
    return r.rows.map(toEntry);
  }

  async head(): Promise<LedgerEntry | null> {
    return (await this.latest(1))[0] ?? null;
  }
}
