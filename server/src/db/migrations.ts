/**
 * Versioned, forward-only migrations. Each runs once, in order, inside a transaction.
 * v1 = the original demo schema (kept so existing databases upgrade cleanly).
 * v2 = real accounts, sites, assets, telemetry, templates, runs, inbox, validation, signatures.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "demo schema",
    sql: `
CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, incident_id TEXT,
  payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS anchors (id SERIAL PRIMARY KEY, kind TEXT NOT NULL, to_seq INTEGER NOT NULL, entry_hash TEXT NOT NULL, ref TEXT NOT NULL,
  url TEXT, data_json TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  },
  {
    version: 2,
    name: "real accounts and data",
    sql: `
-- Archive anything the simulated demo wrote; v2 starts with an empty, real ledger.
ALTER TABLE ledger RENAME TO ledger_v1_demo;
ALTER TABLE anchors RENAME TO anchors_v1_demo;
DROP TABLE IF EXISTS incidents; DROP TABLE IF EXISTS decisions; DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS sim_state; DROP TABLE IF EXISTS sim_actions; DROP TABLE IF EXISTS sim_suppressed;
DELETE FROM settings;

CREATE TABLE ledger (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, subject TEXT,
  payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL UNIQUE);
CREATE INDEX ledger_subject ON ledger (subject);
CREATE TABLE anchors (id SERIAL PRIMARY KEY, kind TEXT NOT NULL, to_seq INTEGER NOT NULL, entry_hash TEXT NOT NULL, ref TEXT NOT NULL,
  url TEXT, data_json TEXT NOT NULL, ts TEXT NOT NULL);

-- Identity
CREATE TABLE users (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, display_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ);
CREATE TABLE auth_nonces (nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL, user_agent TEXT);
CREATE TABLE sites (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE memberships (site_id TEXT NOT NULL REFERENCES sites(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (site_id, user_id, role));
CREATE TABLE invites (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), address TEXT NOT NULL, role TEXT NOT NULL,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), accepted_at TIMESTAMPTZ);
CREATE TABLE signatures (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), address TEXT NOT NULL, action TEXT NOT NULL,
  entity TEXT NOT NULL, meaning TEXT NOT NULL, comment TEXT, typed_data TEXT NOT NULL, signature TEXT NOT NULL, ledger_seq INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE signature_nonces (nonce TEXT PRIMARY KEY, user_id TEXT NOT NULL, entity TEXT NOT NULL, typed_json TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ);

-- Plant model
CREATE TABLE lines (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), name TEXT NOT NULL, autonomy TEXT NOT NULL DEFAULT 'L2',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE zones (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE assets (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), zone_id TEXT REFERENCES zones(id), name TEXT NOT NULL,
  kind TEXT NOT NULL, description TEXT, owning_agent TEXT NOT NULL, source_json TEXT NOT NULL, limits_json TEXT NOT NULL DEFAULT '{}',
  ideal_cycle_s REAL, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), archived_at TIMESTAMPTZ);
CREATE TABLE telemetry (asset_id TEXT NOT NULL, signal TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, value DOUBLE PRECISION, text_value TEXT,
  quality TEXT NOT NULL DEFAULT 'good', PRIMARY KEY (asset_id, signal, ts));
CREATE INDEX telemetry_recent ON telemetry (asset_id, ts DESC);
CREATE TABLE source_state (asset_id TEXT PRIMARY KEY, cursor TEXT, last_poll_at TIMESTAMPTZ, last_ok_at TIMESTAMPTZ, last_error TEXT,
  latest_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE replay_series (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), name TEXT NOT NULL, rows INTEGER NOT NULL,
  duration_ms BIGINT NOT NULL, speed REAL NOT NULL DEFAULT 1, started_at TIMESTAMPTZ, uploaded_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE replay_points (series_id TEXT NOT NULL REFERENCES replay_series(id), t_ms BIGINT NOT NULL, signal TEXT NOT NULL,
  value DOUBLE PRECISION, text_value TEXT);
CREATE INDEX replay_points_t ON replay_points (series_id, t_ms);
CREATE TABLE engine_lease (name TEXT PRIMARY KEY, lease_until BIGINT NOT NULL);

-- Pipelines
CREATE TABLE templates (id TEXT PRIMARY KEY, site_id TEXT, key TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
  origin TEXT NOT NULL, based_on TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), archived_at TIMESTAMPTZ);
CREATE TABLE template_versions (id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES templates(id), version INTEGER NOT NULL,
  spec_json TEXT NOT NULL, note TEXT, published_by TEXT, published_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (template_id, version));
CREATE TABLE runs (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), line_id TEXT REFERENCES lines(id),
  template_version_id TEXT NOT NULL REFERENCES template_versions(id), order_ref TEXT NOT NULL, quantity INTEGER NOT NULL,
  status TEXT NOT NULL, started_by TEXT, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), due_at TIMESTAMPTZ, finished_at TIMESTAMPTZ);
CREATE TABLE stage_runs (run_id TEXT NOT NULL REFERENCES runs(id), code TEXT NOT NULL, state TEXT NOT NULL, asset_id TEXT,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, units_good INTEGER NOT NULL DEFAULT 0, units_scrap INTEGER NOT NULL DEFAULT 0,
  baseline_json TEXT NOT NULL DEFAULT '{}', outcome TEXT, deviation BOOLEAN NOT NULL DEFAULT false, data_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, code));
CREATE TABLE decisions (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, run_id TEXT, stage_code TEXT, incident_id TEXT, asset_id TEXT,
  agent TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, reason TEXT, data_json TEXT NOT NULL DEFAULT '{}', confidence REAL,
  model_id TEXT, ledger_seq INTEGER, ts TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX decisions_run ON decisions (run_id, ts DESC);
CREATE INDEX decisions_site ON decisions (site_id, ts DESC);
CREATE TABLE incidents (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, asset_id TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
  severity TEXT NOT NULL, opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ, data_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE inbox_items (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL, agent TEXT NOT NULL, severity TEXT, run_id TEXT, stage_code TEXT, asset_id TEXT, incident_id TEXT,
  metrics_json TEXT NOT NULL DEFAULT '[]', options_json TEXT NOT NULL DEFAULT '[]', recommended INTEGER, confidence REAL,
  required_role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_option INTEGER, reason TEXT,
  signature_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ);
CREATE INDEX inbox_site ON inbox_items (site_id, status, created_at DESC);

-- Validation
CREATE TABLE validation_packages (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, owner_id TEXT NOT NULL,
  status TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '', sample_plan TEXT NOT NULL DEFAULT '',
  window_start TIMESTAMPTZ, window_end TIMESTAMPTZ, run_id TEXT, stage_code TEXT, template_id TEXT, outcome TEXT NOT NULL DEFAULT '',
  precheck_json TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE validation_checks (id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES validation_packages(id), sort INTEGER NOT NULL,
  criterion TEXT NOT NULL, method TEXT NOT NULL, target TEXT NOT NULL, source TEXT NOT NULL, result TEXT, status TEXT NOT NULL DEFAULT 'pending',
  recorded_by TEXT, recorded_at TIMESTAMPTZ);
CREATE TABLE evidence (id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES validation_packages(id), name TEXT NOT NULL,
  requirement TEXT NOT NULL, filename TEXT, mime TEXT, size INTEGER, sha256 TEXT, url TEXT, uploaded_by TEXT, uploaded_at TIMESTAMPTZ);
`,
  },
  {
    version: 3,
    name: "validation workflow and evidence storage",
    sql: `
ALTER TABLE validation_packages ADD COLUMN number INTEGER;
ALTER TABLE validation_packages ADD COLUMN step TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE validation_packages ADD COLUMN asset_id TEXT;
ALTER TABLE validation_packages ADD COLUMN returned_comment TEXT;
ALTER TABLE validation_checks ADD COLUMN auto BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE validation_checks ADD COLUMN actual TEXT;
ALTER TABLE evidence ADD COLUMN required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE evidence ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE evidence ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE evidence ADD COLUMN removed_at TIMESTAMPTZ;
CREATE TABLE package_signatures (id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES validation_packages(id), meaning TEXT NOT NULL,
  role TEXT NOT NULL, user_id TEXT NOT NULL, address TEXT NOT NULL, signature_id TEXT NOT NULL, comment TEXT, cleared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, bytes BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
`,
  },
];
