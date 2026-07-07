/**
 * Canonical TinyCloud capability URN registry (js-sdk side).
 *
 * Single source of truth for every ability URN the SDK emits. Until the
 * tinycloud-node codegen (TC-112) lands, this module is hand-maintained but
 * consolidated: the bootstrap manifests, the node-sdk default abilities, the
 * SQL/DuckDB service action tables, and the web-sdk permission-modal labels all
 * derive from the constants declared here instead of repeating raw strings.
 *
 * Phase B (post caps-node-dev): the generated `capabilities.ts` gets vendored
 * in and this module re-exports/derives from it, with a CI check asserting the
 * vendored copy matches the registry at the pinned tinycloud-node rev.
 *
 * Status semantics mirror the node registry design:
 * - `active`      — the SDK dispatches this action against a node service.
 * - `reserved`    — declared for forward-compat / recap parsing, not dispatched
 *                   by the SDK today (may have no node handler either).
 *
 * Long form (`tinycloud.<service>/<action>`) is what action URNs and manifest
 * entries use. The short↔long service bridge (`SERVICE_SHORT_TO_LONG`) lives in
 * `sdk-core/manifest.ts` because it encodes the recap-encodable service subset,
 * a narrower concern than this URN registry.
 */

export type CapabilityStatus = "active" | "reserved";

export interface CapabilityRegistryEntry {
  /** Full ability URN, e.g. `tinycloud.kv/get`. */
  urn: string;
  /** Short service segment, e.g. `kv`. */
  service: string;
  /** Action segment, e.g. `get`. */
  action: string;
  /** Whether the SDK dispatches this action today. */
  status: CapabilityStatus;
}

// ---------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------

export const KV = {
  GET: "tinycloud.kv/get",
  PUT: "tinycloud.kv/put",
  DEL: "tinycloud.kv/del",
  LIST: "tinycloud.kv/list",
  METADATA: "tinycloud.kv/metadata",
} as const;

// ---------------------------------------------------------------------------
// SQL
//
// SELECT/INSERT/UPDATE/DELETE are reserved: the SDK does not dispatch them
// (row-level writes all go through `write`). See TC-112 audit. EXECUTE/EXPORT
// are active — SQLService dispatches them. The `*` wildcard is active: the
// node-sdk root delegation grants it.
// ---------------------------------------------------------------------------

export const SQL = {
  READ: "tinycloud.sql/read",
  WRITE: "tinycloud.sql/write",
  SCHEMA: "tinycloud.sql/schema",
  ADMIN: "tinycloud.sql/admin",
  EXECUTE: "tinycloud.sql/execute",
  EXPORT: "tinycloud.sql/export",
  SELECT: "tinycloud.sql/select",
  INSERT: "tinycloud.sql/insert",
  UPDATE: "tinycloud.sql/update",
  DELETE: "tinycloud.sql/delete",
  ALL: "tinycloud.sql/*",
} as const;

// ---------------------------------------------------------------------------
// DuckDB
// ---------------------------------------------------------------------------

export const DUCKDB = {
  READ: "tinycloud.duckdb/read",
  WRITE: "tinycloud.duckdb/write",
  ADMIN: "tinycloud.duckdb/admin",
  DESCRIBE: "tinycloud.duckdb/describe",
  EXPORT: "tinycloud.duckdb/export",
  IMPORT: "tinycloud.duckdb/import",
  EXECUTE: "tinycloud.duckdb/execute",
  ALL: "tinycloud.duckdb/*",
} as const;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CAPABILITIES = {
  READ: "tinycloud.capabilities/read",
} as const;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const HOOKS = {
  SUBSCRIBE: "tinycloud.hooks/subscribe",
  REGISTER: "tinycloud.hooks/register",
  LIST: "tinycloud.hooks/list",
  UNREGISTER: "tinycloud.hooks/unregister",
} as const;

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

export const ENCRYPTION = {
  DECRYPT: "tinycloud.encryption/decrypt",
  NETWORK_CREATE: "tinycloud.encryption/network.create",
  NETWORK_REVOKE: "tinycloud.encryption/network.revoke",
} as const;

// ---------------------------------------------------------------------------
// Space
//
// space/{create,list,info} are LIVE (SpaceService + TinyCloud lazy public-space
// creation dispatch them against the node's /invoke endpoint). space/host is
// used by the bootstrap allowlist.
// ---------------------------------------------------------------------------

export const SPACE = {
  HOST: "tinycloud.space/host",
  CREATE: "tinycloud.space/create",
  LIST: "tinycloud.space/list",
  INFO: "tinycloud.space/info",
} as const;

/**
 * The full registry with per-URN status, used by the canonical-set test and
 * (Phase B) the CI cross-check against the generated node artifact.
 */
export const CAPABILITY_REGISTRY: readonly CapabilityRegistryEntry[] = Object.freeze([
  { urn: KV.GET, service: "kv", action: "get", status: "active" },
  { urn: KV.PUT, service: "kv", action: "put", status: "active" },
  { urn: KV.DEL, service: "kv", action: "del", status: "active" },
  { urn: KV.LIST, service: "kv", action: "list", status: "active" },
  { urn: KV.METADATA, service: "kv", action: "metadata", status: "active" },

  { urn: SQL.READ, service: "sql", action: "read", status: "active" },
  { urn: SQL.WRITE, service: "sql", action: "write", status: "active" },
  { urn: SQL.SCHEMA, service: "sql", action: "schema", status: "active" },
  { urn: SQL.ADMIN, service: "sql", action: "admin", status: "active" },
  { urn: SQL.EXECUTE, service: "sql", action: "execute", status: "active" },
  { urn: SQL.EXPORT, service: "sql", action: "export", status: "active" },
  { urn: SQL.ALL, service: "sql", action: "*", status: "active" },
  { urn: SQL.SELECT, service: "sql", action: "select", status: "reserved" },
  { urn: SQL.INSERT, service: "sql", action: "insert", status: "reserved" },
  { urn: SQL.UPDATE, service: "sql", action: "update", status: "reserved" },
  { urn: SQL.DELETE, service: "sql", action: "delete", status: "reserved" },

  { urn: DUCKDB.READ, service: "duckdb", action: "read", status: "active" },
  { urn: DUCKDB.WRITE, service: "duckdb", action: "write", status: "active" },
  { urn: DUCKDB.ADMIN, service: "duckdb", action: "admin", status: "active" },
  { urn: DUCKDB.DESCRIBE, service: "duckdb", action: "describe", status: "active" },
  { urn: DUCKDB.EXPORT, service: "duckdb", action: "export", status: "active" },
  { urn: DUCKDB.IMPORT, service: "duckdb", action: "import", status: "active" },
  { urn: DUCKDB.EXECUTE, service: "duckdb", action: "execute", status: "active" },
  { urn: DUCKDB.ALL, service: "duckdb", action: "*", status: "active" },

  { urn: CAPABILITIES.READ, service: "capabilities", action: "read", status: "active" },

  { urn: HOOKS.SUBSCRIBE, service: "hooks", action: "subscribe", status: "active" },
  { urn: HOOKS.REGISTER, service: "hooks", action: "register", status: "active" },
  { urn: HOOKS.LIST, service: "hooks", action: "list", status: "active" },
  { urn: HOOKS.UNREGISTER, service: "hooks", action: "unregister", status: "active" },

  { urn: ENCRYPTION.DECRYPT, service: "encryption", action: "decrypt", status: "active" },
  { urn: ENCRYPTION.NETWORK_CREATE, service: "encryption", action: "network.create", status: "active" },
  { urn: ENCRYPTION.NETWORK_REVOKE, service: "encryption", action: "network.revoke", status: "reserved" },

  { urn: SPACE.HOST, service: "space", action: "host", status: "active" },
  { urn: SPACE.CREATE, service: "space", action: "create", status: "active" },
  { urn: SPACE.LIST, service: "space", action: "list", status: "active" },
  { urn: SPACE.INFO, service: "space", action: "info", status: "active" },
]);
