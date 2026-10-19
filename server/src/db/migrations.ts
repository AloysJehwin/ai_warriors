/**
 * Versioned, forward-only migrations. Each runs once, in order, inside a transaction.
 * v1 = the original demo schema (kept so existing databases upgrade cleanly).
 * v2 = real accounts, sites, assets, telemetry, templates, runs, inbox, validation, signatures.
 * v3 = validation workflow · v4 = onboarding and on-chain trust · v5 = agent work orders and autonomy proposals · v6 = lot passports · v7 = jobs on other networks (ENS, 0G) · v11–15 = ENS lot names and credentials, Hedera schedules, one World ID per validator, zero-knowledge spec proofs, agent licences.
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
  {
    version: 4,
    name: "onboarding, validators, vendors, on-chain trust",
    sql: `
CREATE TABLE onboarding_requests (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), user_id TEXT NOT NULL REFERENCES users(id),
  address TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL, form_json TEXT NOT NULL, files_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TIMESTAMPTZ, reason TEXT, signature_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX onboarding_site ON onboarding_requests (site_id, status, created_at DESC);
CREATE TABLE validators (site_id TEXT NOT NULL REFERENCES sites(id), user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved', request_id TEXT, approved_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (site_id, user_id));
CREATE TABLE vendors (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), user_id TEXT, address TEXT NOT NULL, company TEXT NOT NULL,
  categories TEXT NOT NULL DEFAULT '', hourly_rate TEXT, response_minutes INTEGER, status TEXT NOT NULL DEFAULT 'approved', request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE chain_sites (site_id TEXT PRIMARY KEY REFERENCES sites(id), chain_id INTEGER NOT NULL, contract TEXT NOT NULL, tx_hash TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE chain_relays (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL, tx_hash TEXT, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX chain_relays_ref ON chain_relays (site_id, ref);
CREATE TABLE slash_proposals (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), validator_user_id TEXT NOT NULL,
  validator_address TEXT NOT NULL, amount TEXT NOT NULL, reason TEXT NOT NULL, recall_package_id TEXT, created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), executed_at TIMESTAMPTZ);
CREATE TABLE slash_signatures (proposal_id TEXT NOT NULL REFERENCES slash_proposals(id), user_id TEXT NOT NULL, address TEXT NOT NULL,
  signature_id TEXT NOT NULL, capacity TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (proposal_id, user_id));
`,
  },
  {
    version: 5,
    name: "agent work orders, autonomy proposals",
    sql: `
CREATE TABLE site_agents (site_id TEXT PRIMARY KEY REFERENCES sites(id), address TEXT NOT NULL, per_order TEXT NOT NULL, per_day TEXT NOT NULL,
  set_by TEXT NOT NULL, signature_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE work_orders (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), asset_id TEXT, run_id TEXT, title TEXT NOT NULL,
  priority TEXT NOT NULL, vendor_id TEXT, vendor_address TEXT, amount TEXT, incident_hash TEXT, status TEXT NOT NULL, payer TEXT,
  escrow_tx TEXT, escrow_url TEXT, expires_at TIMESTAMPTZ, released_by TEXT, error TEXT, opened_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX work_orders_site ON work_orders (site_id, created_at DESC);
ALTER TABLE lines ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE autonomy_proposals (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), line_id TEXT NOT NULL REFERENCES lines(id),
  from_level TEXT NOT NULL, to_level TEXT NOT NULL, policy_hash TEXT NOT NULL, version INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ);
CREATE TABLE autonomy_signatures (proposal_id TEXT NOT NULL REFERENCES autonomy_proposals(id), user_id TEXT NOT NULL, address TEXT NOT NULL,
  signature_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (proposal_id, user_id));
`,
  },
  {
    version: 6,
    name: "lot passports",
    sql: `
CREATE TABLE passports (run_id TEXT PRIMARY KEY REFERENCES runs(id), site_id TEXT NOT NULL REFERENCES sites(id), status TEXT NOT NULL,
  token_id TEXT, serial INTEGER, onchain_status TEXT, mint_tx TEXT, last_tx TEXT, error TEXT, next_try_at TIMESTAMPTZ,
  shipped_to TEXT, shipped_at TIMESTAMPTZ, ship_tx TEXT, ship_pending BOOLEAN, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX passports_site ON passports (site_id, created_at DESC);
`,
  },
  {
    version: 7,
    name: "jobs on other networks",
    sql: `
CREATE TABLE chain_jobs (id TEXT PRIMARY KEY, site_id TEXT, kind TEXT NOT NULL, ref TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL, result_json TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX chain_jobs_due ON chain_jobs (status, next_try_at);
CREATE INDEX chain_jobs_ref ON chain_jobs (kind, ref);
`,
  },
  {
    version: 8,
    name: "ENS names",
    sql: `
CREATE TABLE ens_names (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), kind TEXT NOT NULL, ref TEXT NOT NULL,
  label TEXT NOT NULL, name TEXT NOT NULL, registry TEXT, want_json TEXT NOT NULL, have_json TEXT, status TEXT NOT NULL,
  stage TEXT, sent_json TEXT, pending_txs TEXT, sent_at TIMESTAMPTZ,
  tx_hash TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX ens_names_ref ON ens_names (site_id, kind, ref);
CREATE UNIQUE INDEX ens_names_name ON ens_names (name);
CREATE INDEX ens_names_due ON ens_names (status, next_try_at);
`,
  },
  {
    version: 9,
    name: "agent iNFTs",
    sql: `
CREATE TABLE agent_nfts (site_id TEXT NOT NULL REFERENCES sites(id), agent TEXT NOT NULL, token_id INTEGER, want_json TEXT NOT NULL,
  have_json TEXT, status TEXT NOT NULL, tx_hash TEXT, mint_tx TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (site_id, agent));
`,
  },
  {
    version: 10,
    name: "public pipelines",
    sql: `
ALTER TABLE sites ADD COLUMN public_pipelines BOOLEAN NOT NULL DEFAULT true;
`,
  },
  {
    version: 11,
    name: "ENS lot names and credentials",
    sql: `
CREATE TABLE ens_lots (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), kind TEXT NOT NULL, ref TEXT NOT NULL, run_id TEXT,
  label TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, pending_txs TEXT, sent_at TIMESTAMPTZ,
  tx_hash TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX ens_lots_ref ON ens_lots (kind, ref);
CREATE UNIQUE INDEX ens_lots_lot_name ON ens_lots (name) WHERE kind = 'lot';
CREATE INDEX ens_lots_due ON ens_lots (status, next_try_at);
CREATE INDEX ens_lots_run ON ens_lots (run_id);
`,
  },
  {
    version: 12,
    name: "Hedera schedules",
    sql: `
CREATE TABLE hedera_schedules (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  execute_at TIMESTAMPTZ NOT NULL, schedule_id TEXT, tx_id TEXT, status TEXT NOT NULL, executed_at TIMESTAMPTZ, error TEXT,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX hedera_schedules_ref ON hedera_schedules (kind, ref);
CREATE INDEX hedera_schedules_open ON hedera_schedules (kind, status, execute_at);
`,
  },
  {
    version: 13,
    name: "one World ID per validator",
    sql: `
ALTER TABLE onboarding_requests ADD COLUMN world_id_nullifier TEXT;
CREATE TABLE validator_humans (site_id TEXT NOT NULL REFERENCES sites(id), nullifier TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  address TEXT NOT NULL, verified_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (site_id, nullifier));
CREATE UNIQUE INDEX validator_humans_user ON validator_humans (site_id, user_id);
`,
  },
  {
    version: 14,
    name: "zero-knowledge spec proofs",
    sql: `
CREATE TABLE spec_proofs (run_id TEXT NOT NULL REFERENCES runs(id), stage_code TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
  subject TEXT, value TEXT, salt TEXT, target TEXT, op INTEGER, commitment TEXT, ledger_seq INTEGER, proof_json TEXT, error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), proven_at TIMESTAMPTZ, PRIMARY KEY (run_id, stage_code, label));
CREATE INDEX spec_proofs_due ON spec_proofs (status, created_at);
`,
  },
  {
    version: 15,
    name: "agent licences",
    sql: `
ALTER TABLE agent_nfts ADD COLUMN contract TEXT;
CREATE TABLE agent_licenses (id TEXT PRIMARY KEY, licensor_site TEXT NOT NULL REFERENCES sites(id), licensee_site TEXT NOT NULL REFERENCES sites(id),
  agent TEXT NOT NULL, token_id INTEGER, contract TEXT, status TEXT NOT NULL, days INTEGER NOT NULL, expires_at TIMESTAMPTZ,
  terms_json TEXT, terms_hash TEXT, playbook_json TEXT, playbook_sha TEXT, storage_root TEXT, storage_tx TEXT,
  grant_sig_json TEXT, revoke_sig_json TEXT, tx_hash TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(), requested_by TEXT NOT NULL, granted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX agent_licenses_licensee ON agent_licenses (licensee_site, agent, status);
CREATE INDEX agent_licenses_due ON agent_licenses (status, next_try_at);
`,
  },
];
