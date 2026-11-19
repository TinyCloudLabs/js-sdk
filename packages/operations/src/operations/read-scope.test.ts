import { expect, test } from "bun:test";

import { evaluateOperationAuthority, validateExactCapabilities } from "../authority.js";
import type { RuntimeOperationContext } from "../contract.js";
import { readScopeOperationDefinitions } from "./read-scope.js";

const operation = readScopeOperationDefinitions[0]!;
const owner = "0x1111111111111111111111111111111111111111";
const space = `tinycloud:pkh:eip155:1:${owner}:applications`;
const context: RuntimeOperationContext = {
  summary: {
    profile: "delegate", host: "https://node.tinycloud.test", posture: "delegate-session",
    ownerDid: `did:pkh:eip155:1:${owner}`, sessionDid: "did:key:delegate", space,
  },
  runtime: { node: {}, granted: [] },
};

test("explicit subtree consent covers future descendants but neither siblings nor writes", async () => {
  const input = operation.input.parse({ space: "applications", kvPrefixes: ["notes/"], databases: ["notes-db"] });
  const grants = validateExactCapabilities(await operation.authority(context, input));
  if (grants === undefined) throw new Error("invalid permission plan");
  const can = (service: string, path: string, action: string, targetSpace = space) =>
    evaluateOperationAuthority(grants, [{ service, space: targetSpace, path, actions: [action] }]).satisfied;
  expect(can("tinycloud.kv", "notes/new/future", "tinycloud.kv/get")).toBe(true);
  expect(can("tinycloud.kv", "notes/new/future", "tinycloud.kv/metadata")).toBe(true);
  expect(can("tinycloud.kv", "notes/", "tinycloud.kv/list")).toBe(true);
  for (const path of ["notes", "notes-other/item", "unrelated/item"]) {
    expect(can("tinycloud.kv", path, "tinycloud.kv/get")).toBe(false);
  }
  expect(can("tinycloud.kv", "notes/item", "tinycloud.kv/put")).toBe(false);
  expect(can("tinycloud.kv", "notes/item", "tinycloud.kv/del")).toBe(false);
  expect(can("tinycloud.sql", "notes-db", "tinycloud.sql/read")).toBe(true);
  expect(can("tinycloud.sql", "notes-db", "tinycloud.sql/write")).toBe(false);
  expect(can("tinycloud.sql", "notes-db/child", "tinycloud.sql/read")).toBe(false);
  expect(can("tinycloud.sql", "another-db", "tinycloud.sql/read")).toBe(false);
  expect(can("tinycloud.kv", "notes/item", "tinycloud.kv/get", space.replace(owner, "0x2222222222222222222222222222222222222222"))).toBe(false);
});

test("read scope rejects empty intent, ambiguous folders, wildcards and protected or foreign spaces", async () => {
  for (const invalid of [
    { space: "applications" },
    { space: "applications", kvPrefixes: [] },
    { space: "applications", kvPrefixes: ["notes"] },
    { space: "applications", kvPrefixes: ["/"] },
    { space: "applications", kvPrefixes: ["notes/**"] },
    { space: "applications", kvPrefixes: ["notes/\n/"] },
    { space: "applications", databases: ["notes/"] },
    { space: "applications", databases: ["*"] },
    { space: "applications", kvPrefixes: ["notes/"], actions: ["tinycloud.kv/put"] },
  ]) expect(operation.input.safeParse(invalid).success).toBe(false);

  for (const target of ["account", "secrets", space.replace(owner, "0x2222222222222222222222222222222222222222")]) {
    const input = operation.input.parse({ space: target, kvPrefixes: ["notes/"] });
    await expect(operation.authority(context, input)).rejects.toMatchObject({ operationError: { code: "INPUT_INVALID" } });
  }
});

test("whole-space reads require an explicit empty prefix and duplicate selections do not expand scope", async () => {
  const input = operation.input.parse({ space: "applications", kvPrefixes: ["", ""], databases: ["notes", "notes"] });
  const planned = validateExactCapabilities(await operation.authority(context, input));
  if (planned === undefined) throw new Error("invalid permission plan");
  expect(planned).toHaveLength(2);
  const required = (path: string) => [{ service: "tinycloud.kv", space, path, actions: ["tinycloud.kv/get"] }];
  expect(evaluateOperationAuthority(planned, required("new-app/unknown/file")).satisfied).toBe(true);
  expect(evaluateOperationAuthority(planned, [{ service: "tinycloud.kv", space, path: "new-app/unknown/file", actions: ["tinycloud.kv/put"] }]).satisfied).toBe(false);
});
