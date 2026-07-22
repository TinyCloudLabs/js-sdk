/**
 * Canonical TinyCloud capability URN registry (js-sdk side).
 *
 * TC-112 single source of truth: the registry is defined in tinycloud-node
 * (`capabilities.json` + codegen) and vendored here VERBATIM as
 * `./generated/capabilities.ts` — the ONE copy in this repo. A CI job
 * (`.github/workflows/capabilities-sync.yml`) fetches the generated file from
 * tinycloud-node at the rev pinned in `packages/sdk-rs/Cargo.toml` and fails on
 * any diff against the vendored copy, so this module can never silently drift
 * from the enforcer.
 *
 * Everything below is DERIVED from the vendored registry by mechanical string
 * transform — there is no second hand-maintained action list. The bootstrap
 * manifests, the node-sdk default abilities, the SQL/DuckDB service action
 * tables, and the web-sdk permission-modal labels all consume the constants
 * declared here.
 *
 * The only hand-authored URNs are the four request-kind artifacts
 * (`sql/execute`, `sql/export`, `duckdb/describe`, `duckdb/execute`): the node
 * routes these by request-body kind gated by read/write/admin — they are NOT
 * grantable capabilities and are intentionally absent from the vendored
 * registry. The SDK keeps them as exported constants because the service
 * clients send them as the invocation ability today (wire alignment tracked in
 * TC-114). They are excluded from `CAPABILITY_REGISTRY`.
 */

import {
  CAPABILITIES as GENERATED_CAPABILITIES,
  type CapabilityEntry,
  type CapabilityStatus,
} from "./generated/capabilities.js";

export type { CapabilityStatus };

/**
 * A single registry entry. Alias of the vendored `CapabilityEntry` so the
 * public type name stays stable while the shape tracks the node registry
 * (long-form `service`, optional `aliasOf`/`implies`).
 */
export type CapabilityRegistryEntry = CapabilityEntry;

// ---------------------------------------------------------------------------
// Derivation
//
// Each registry URN is `tinycloud.<service>/<action>`. The per-service constant
// objects below are built by stripping the `tinycloud.<service>/` prefix and
// upper-casing the action into a key (`.` -> `_`, `*` -> `ALL`). This is a pure
// string transform over the vendored registry — no action is named twice.
// ---------------------------------------------------------------------------

function actionKey(action: string): string {
  if (action === "*") return "ALL";
  return action.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function serviceOf(urn: string): string {
  // "tinycloud.sql/read" -> "sql"
  return urn.slice("tinycloud.".length, urn.indexOf("/"));
}

function actionOf(urn: string): string {
  return urn.slice(urn.indexOf("/") + 1);
}

function deriveServiceConstants(service: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of GENERATED_CAPABILITIES) {
    if (serviceOf(entry.urn) !== service) continue;
    out[actionKey(actionOf(entry.urn))] = entry.urn;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-service constants (long-form `tinycloud.<service>/<action>` URNs).
// ---------------------------------------------------------------------------

export const KV = deriveServiceConstants("kv") as {
  GET: "tinycloud.kv/get";
  LIST: "tinycloud.kv/list";
  METADATA: "tinycloud.kv/metadata";
  PUT: "tinycloud.kv/put";
  DEL: "tinycloud.kv/del";
  DELETE: "tinycloud.kv/delete";
};

// `execute`/`export` are request-kind artifacts, not registry capabilities —
// hand-authored (see module header, TC-114).
export const SQL = {
  ...deriveServiceConstants("sql"),
  EXECUTE: "tinycloud.sql/execute",
  EXPORT: "tinycloud.sql/export",
} as {
  READ: "tinycloud.sql/read";
  SELECT: "tinycloud.sql/select";
  WRITE: "tinycloud.sql/write";
  SCHEMA: "tinycloud.sql/schema";
  ADMIN: "tinycloud.sql/admin";
  ALL: "tinycloud.sql/*";
  EXECUTE: "tinycloud.sql/execute";
  EXPORT: "tinycloud.sql/export";
};

// `describe`/`execute` are request-kind artifacts, not registry capabilities —
// hand-authored (see module header, TC-114).
export const DUCKDB = {
  ...deriveServiceConstants("duckdb"),
  DESCRIBE: "tinycloud.duckdb/describe",
  EXECUTE: "tinycloud.duckdb/execute",
} as {
  READ: "tinycloud.duckdb/read";
  WRITE: "tinycloud.duckdb/write";
  ADMIN: "tinycloud.duckdb/admin";
  IMPORT: "tinycloud.duckdb/import";
  EXPORT: "tinycloud.duckdb/export";
  SELECT: "tinycloud.duckdb/select";
  ALL: "tinycloud.duckdb/*";
  DESCRIBE: "tinycloud.duckdb/describe";
  EXECUTE: "tinycloud.duckdb/execute";
};

export const CAPABILITIES = deriveServiceConstants("capabilities") as {
  READ: "tinycloud.capabilities/read";
};

export const HOOKS = deriveServiceConstants("hooks") as {
  SUBSCRIBE: "tinycloud.hooks/subscribe";
  REGISTER: "tinycloud.hooks/register";
  LIST: "tinycloud.hooks/list";
  UNREGISTER: "tinycloud.hooks/unregister";
};

export const ENCRYPTION = deriveServiceConstants("encryption") as {
  DECRYPT: "tinycloud.encryption/decrypt";
  NETWORK_CREATE: "tinycloud.encryption/network.create";
  NETWORK_REVOKE: "tinycloud.encryption/network.revoke";
};

export const SPACE = deriveServiceConstants("space") as {
  HOST: "tinycloud.space/host";
  CREATE: "tinycloud.space/create";
  LIST: "tinycloud.space/list";
  INFO: "tinycloud.space/info";
};

// `list` is registry status "reserved" (no server-side handler yet, §12.1/C9
// of the compute-service spec) but still present as a URN constant. `ALL`
// (`tinycloud.compute/*`) implies only the two ACTIVE concretes (deploy,
// execute) per the registry's wildcard-implication rule — it does NOT imply
// `list`. Callers must never grant `ALL` in a standard session: it confers
// `deploy`, which is a privileged, explicit-only capability (compute-service.md
// §12.1 F9).
export const COMPUTE = deriveServiceConstants("compute") as {
  EXECUTE: "tinycloud.compute/execute";
  DEPLOY: "tinycloud.compute/deploy";
  LIST: "tinycloud.compute/list";
  ALL: "tinycloud.compute/*";
};

/**
 * The full registry with per-URN status/alias/implication metadata. Re-exported
 * verbatim from the vendored node artifact — used by the canonical-set test and
 * the CI cross-check. The four request-kind artifacts are intentionally NOT
 * present here (see module header).
 */
export const CAPABILITY_REGISTRY: readonly CapabilityRegistryEntry[] =
  GENERATED_CAPABILITIES;
