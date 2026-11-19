import { expect, test } from "bun:test";

import type { PermissionEntry } from "@tinycloud/node-sdk";

import { nativeOwnerForConnectorGrant } from "./native-auth.js";

const OWNER_SPACE = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications";
const EXACT_CONNECTOR_GRANT: PermissionEntry[] = [
  {
    service: "tinycloud.sql",
    space: OWNER_SPACE,
    path: "xyz.tinycloud.tinychat/connectors",
    actions: ["tinycloud.sql/read"],
  },
  {
    service: "tinycloud.kv",
    space: OWNER_SPACE,
    path: "xyz.tinycloud.tinychat/connectors/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
  },
];

test("derives the owner only from the exact signed applications connector scope", () => {
  const ownerDid = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
  expect(nativeOwnerForConnectorGrant(EXACT_CONNECTOR_GRANT)).toBe(ownerDid);
  expect(nativeOwnerForConnectorGrant([...EXACT_CONNECTOR_GRANT].reverse())).toBe(ownerDid);
});

test("refuses widened, incomplete, caveated, or cross-owner connector grants", () => {
  expect(nativeOwnerForConnectorGrant([
    ...EXACT_CONNECTOR_GRANT,
    { service: "tinycloud.sql", space: OWNER_SPACE, path: "", actions: ["tinycloud.sql/read"] },
  ])).toBeUndefined();
  expect(nativeOwnerForConnectorGrant([
    EXACT_CONNECTOR_GRANT[0]!,
    { ...EXACT_CONNECTOR_GRANT[1]!, actions: ["tinycloud.kv/get"] },
  ])).toBeUndefined();
  expect(nativeOwnerForConnectorGrant([
    EXACT_CONNECTOR_GRANT[0]!,
    { ...EXACT_CONNECTOR_GRANT[1]!, caveats: [{ tenant: "other" }] },
  ])).toBeUndefined();
  expect(nativeOwnerForConnectorGrant([
    EXACT_CONNECTOR_GRANT[0]!,
    { ...EXACT_CONNECTOR_GRANT[1]!, space: "tinycloud:pkh:eip155:1:0x2222222222222222222222222222222222222222:applications" },
  ])).toBeUndefined();
});
