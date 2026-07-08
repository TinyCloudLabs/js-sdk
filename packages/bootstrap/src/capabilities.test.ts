import { expect, test } from "bun:test";

import {
  KV,
  SQL,
  DUCKDB,
  CAPABILITIES,
  HOOKS,
  ENCRYPTION,
  SPACE,
  CAPABILITY_REGISTRY,
} from "./capabilities";

const status = (urn: string) =>
  CAPABILITY_REGISTRY.find((e) => e.urn === urn)?.status;
const registryUrns = () => CAPABILITY_REGISTRY.map((e) => e.urn);

// URNs kept as exported constants but intentionally absent from the registry:
// the node routes them by request-body kind, not as grantable capabilities
// (TC-112 grounding, wire alignment tracked in TC-114).
const REQUEST_KIND_URNS = new Set<string>([
  SQL.EXECUTE,
  SQL.EXPORT,
  DUCKDB.DESCRIBE,
  DUCKDB.EXECUTE,
]);

test("kv delete URN is `del`; `delete` is a deprecated alias, never active", () => {
  expect(KV.DEL).toBe("tinycloud.kv/del");
  expect(registryUrns()).toContain("tinycloud.kv/del");
  expect(status("tinycloud.kv/del")).toBe("active");
  expect(status("tinycloud.kv/delete")).toBe("deprecated-alias");
});

test("registry contains no rejected `sql/ddl` action", () => {
  expect(registryUrns()).not.toContain("tinycloud.sql/ddl");
});

test("dropped SQL phantoms are absent from the registry and the SQL constant", () => {
  // insert/update/delete were dropped node-side (zero refs, never accepted).
  for (const urn of [
    "tinycloud.sql/insert",
    "tinycloud.sql/update",
    "tinycloud.sql/delete",
  ]) {
    expect(registryUrns()).not.toContain(urn);
  }
  expect(SQL).not.toHaveProperty("INSERT");
  expect(SQL).not.toHaveProperty("UPDATE");
  expect(SQL).not.toHaveProperty("DELETE");
});

test("every registry-backed constant resolves to a registry entry", () => {
  const byUrn = new Map(CAPABILITY_REGISTRY.map((e) => [e.urn, e]));
  const groups = [KV, SQL, DUCKDB, CAPABILITIES, HOOKS, ENCRYPTION, SPACE];
  for (const group of groups) {
    for (const urn of Object.values(group)) {
      if (REQUEST_KIND_URNS.has(urn)) {
        // Request-kind artifact: exported constant, not a registry capability.
        expect(byUrn.has(urn)).toBe(false);
        continue;
      }
      const entry = byUrn.get(urn);
      expect(entry).toBeDefined();
      // Vendored registry uses long-form service names (`tinycloud.<svc>`).
      expect(entry!.service).toBe(urn.slice(0, urn.indexOf("/")));
    }
  }
});

test("request-kind actions are NOT registry capabilities", () => {
  const urns = registryUrns();
  for (const urn of REQUEST_KIND_URNS) {
    expect(urns).not.toContain(urn);
  }
});

test("status vocabulary is the three-way active / deprecated-alias / reserved", () => {
  for (const entry of CAPABILITY_REGISTRY) {
    expect(["active", "deprecated-alias", "reserved"]).toContain(entry.status);
    if (entry.status === "deprecated-alias") {
      expect(typeof entry.aliasOf).toBe("string");
    }
  }
});

test("sql/select and duckdb/select are deprecated aliases of read", () => {
  const sqlSelect = CAPABILITY_REGISTRY.find((e) => e.urn === SQL.SELECT);
  expect(sqlSelect?.status).toBe("deprecated-alias");
  expect(sqlSelect?.aliasOf).toBe(SQL.READ);

  const duckSelect = CAPABILITY_REGISTRY.find((e) => e.urn === DUCKDB.SELECT);
  expect(duckSelect?.status).toBe("deprecated-alias");
  expect(duckSelect?.aliasOf).toBe(DUCKDB.READ);
});

test("duckdb import/export are active; wildcards active", () => {
  expect(status(DUCKDB.IMPORT)).toBe("active");
  expect(status(DUCKDB.EXPORT)).toBe("active");
  expect(status(SQL.ALL)).toBe("active");
  expect(status(DUCKDB.ALL)).toBe("active");
});

test("space host/create/list/info are all active", () => {
  expect(status(SPACE.HOST)).toBe("active");
  expect(status(SPACE.CREATE)).toBe("active");
  expect(status(SPACE.LIST)).toBe("active");
  expect(status(SPACE.INFO)).toBe("active");
});

test("vfs actions are reserved", () => {
  const vfs = CAPABILITY_REGISTRY.filter((e) =>
    e.urn.startsWith("tinycloud.vfs/"),
  );
  expect(vfs.length).toBeGreaterThan(0);
  for (const entry of vfs) {
    expect(entry.status).toBe("reserved");
  }
});

test("registry URNs are unique", () => {
  const urns = registryUrns();
  expect(new Set(urns).size).toBe(urns.length);
});

// The `as { KEY: "urn" }` casts on the constant groups assert keys the runtime
// never verifies: if a re-vendor drops a registry entry, the derived constant
// silently becomes `undefined` (Object.values-based tests can't see a missing
// key). Lock the exact key set per group and assert every value resolves.
test("every constant-group key is present and resolves to a URN", () => {
  const groups: Record<string, [Record<string, string>, string[]]> = {
    KV: [KV, ["GET", "LIST", "METADATA", "PUT", "DEL", "DELETE"]],
    SQL: [SQL, ["READ", "SELECT", "WRITE", "SCHEMA", "ADMIN", "ALL", "EXECUTE", "EXPORT"]],
    DUCKDB: [DUCKDB, ["READ", "WRITE", "ADMIN", "IMPORT", "EXPORT", "SELECT", "ALL", "DESCRIBE", "EXECUTE"]],
    CAPABILITIES: [CAPABILITIES, ["READ"]],
    HOOKS: [HOOKS, ["SUBSCRIBE", "REGISTER", "LIST", "UNREGISTER"]],
    ENCRYPTION: [ENCRYPTION, ["DECRYPT", "NETWORK_CREATE", "NETWORK_REVOKE"]],
    SPACE: [SPACE, ["HOST", "CREATE", "LIST", "INFO"]],
  };
  for (const [name, [group, expectedKeys]] of Object.entries(groups)) {
    expect(Object.keys(group).sort()).toEqual([...expectedKeys].sort());
    for (const key of expectedKeys) {
      const value = group[key];
      expect(value, `${name}.${key} must resolve to a URN`).toBeTruthy();
      expect(value.startsWith("tinycloud.")).toBe(true);
    }
  }
});
