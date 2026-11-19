// Source-created SQLite mirror DDL shared by the store and read-only layout validator.
export const SCHEMA_VERSION = 2;
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS replica (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  host TEXT NOT NULL,
  space TEXT NOT NULL,
  prefix TEXT NOT NULL,
  device_did TEXT NOT NULL,
  allow_secrets INTEGER NOT NULL CHECK (allow_secrets IN (0, 1)),
  local_read_policy TEXT NOT NULL CHECK (local_read_policy IN ('whileGrantValid', 'retainAfterExpiry')),
  retention_grant_cid TEXT,
  grant_cid TEXT,
  grant_bytes BLOB,
  grant_audience TEXT,
  grant_issuer TEXT,
  grant_nbf INTEGER,
  grant_exp INTEGER,
  pending_grant_cid TEXT,
  pending_grant_bytes BLOB,
  pending_grant_audience TEXT,
  pending_grant_issuer TEXT,
  pending_grant_nbf INTEGER,
  pending_grant_exp INTEGER,
  node_did TEXT,
  attested INTEGER NOT NULL DEFAULT 0 CHECK (attested IN (0, 1)),
  not_before TEXT,
  expires_at TEXT,
  retain_until TEXT,
  revoked_detail TEXT,
  purge_pending INTEGER NOT NULL DEFAULT 0 CHECK (purge_pending IN (0, 1)),
  retention_revoked TEXT,
  pending_grant_error TEXT,
  cursor TEXT,
  coverage TEXT NOT NULL CHECK (coverage IN ('empty', 'bootstrapping', 'complete')),
  generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_complete_at TEXT,
  last_error TEXT,
  last_reset TEXT,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_holder TEXT,
  lease_expires_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS entry (
  key TEXT PRIMARY KEY,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  etag TEXT,
  hash TEXT,
  metadata TEXT NOT NULL,
  content INTEGER NOT NULL CHECK (content IN (0, 1)),
  size INTEGER,
  CHECK (
    (deleted = 1 AND etag IS NULL AND hash IS NULL AND content = 0 AND size IS NULL) OR
    (deleted = 0 AND etag IS NOT NULL AND hash IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS entry_hash ON entry (hash) WHERE hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS grant_install (
  cid TEXT PRIMARY KEY,
  installed_at INTEGER NOT NULL,
  effective_expires_at INTEGER NOT NULL,
  consent_deadline INTEGER NOT NULL,
  consent_anchor_at INTEGER NOT NULL,
  consent_anchor_source TEXT NOT NULL
) STRICT, WITHOUT ROWID;
`;
