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

test("kv delete URN is `del`, never `delete`", () => {
  expect(KV.DEL).toBe("tinycloud.kv/del");
  const urns = CAPABILITY_REGISTRY.map((e) => e.urn);
  expect(urns).toContain("tinycloud.kv/del");
  expect(urns).not.toContain("tinycloud.kv/delete");
});

test("registry contains no rejected `sql/ddl` action", () => {
  const urns = CAPABILITY_REGISTRY.map((e) => e.urn);
  expect(urns).not.toContain("tinycloud.sql/ddl");
});

test("every constant appears in the registry with a matching service/action", () => {
  const byUrn = new Map(CAPABILITY_REGISTRY.map((e) => [e.urn, e]));
  const groups: Array<[string, Record<string, string>]> = [
    ["kv", KV],
    ["sql", SQL],
    ["duckdb", DUCKDB],
    ["capabilities", CAPABILITIES],
    ["hooks", HOOKS],
    ["encryption", ENCRYPTION],
    ["space", SPACE],
  ];
  for (const [service, group] of groups) {
    for (const urn of Object.values(group)) {
      const entry = byUrn.get(urn);
      expect(entry).toBeDefined();
      expect(entry!.service).toBe(service);
      expect(urn).toBe(`tinycloud.${service}/${entry!.action}`);
    }
  }
});

test("known-active SQL/DuckDB actions the SDK dispatches are marked active", () => {
  const status = (urn: string) =>
    CAPABILITY_REGISTRY.find((e) => e.urn === urn)?.status;
  // SQLService / DuckDbService dispatch these — they must not be reserved.
  expect(status(SQL.EXECUTE)).toBe("active");
  expect(status(SQL.EXPORT)).toBe("active");
  expect(status(DUCKDB.DESCRIBE)).toBe("active");
  expect(status(DUCKDB.EXECUTE)).toBe("active");
  expect(status(DUCKDB.IMPORT)).toBe("active");
});

test("undispatched SQL row-verbs are marked reserved", () => {
  const status = (urn: string) =>
    CAPABILITY_REGISTRY.find((e) => e.urn === urn)?.status;
  expect(status(SQL.SELECT)).toBe("reserved");
  expect(status(SQL.INSERT)).toBe("reserved");
  expect(status(SQL.UPDATE)).toBe("reserved");
  expect(status(SQL.DELETE)).toBe("reserved");
});

test("space create/list/info are active (SDK dispatches them)", () => {
  const status = (urn: string) =>
    CAPABILITY_REGISTRY.find((e) => e.urn === urn)?.status;
  expect(status(SPACE.CREATE)).toBe("active");
  expect(status(SPACE.LIST)).toBe("active");
  expect(status(SPACE.INFO)).toBe("active");
  expect(status(SPACE.HOST)).toBe("active");
});

test("registry URNs are unique", () => {
  const urns = CAPABILITY_REGISTRY.map((e) => e.urn);
  expect(new Set(urns).size).toBe(urns.length);
});
