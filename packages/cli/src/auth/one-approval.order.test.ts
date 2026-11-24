import { expect, test } from "bun:test";
import { grantRequestPermissions, scopedLoginPermissions } from "./scoped-login.js";

const read = { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] };
const decrypt = { service: "tinycloud.encryption", space: "encryption", path: "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:default", actions: ["tinycloud.encryption/decrypt"] };
const discovery = { service: "tinycloud.capabilities", space: "secrets", path: "", actions: ["tinycloud.capabilities/read"] };

test("single-space scoped login preserves data and raw-encryption entry order", () => {
  expect(scopedLoginPermissions([read, decrypt])).toEqual([discovery, read, decrypt]);
});
test("single-space grant preserves raw-decrypt order and anchors decrypt-only requests", () => {
  expect(grantRequestPermissions([read, decrypt], "secrets")).toEqual([discovery, read, decrypt]);
  expect(grantRequestPermissions([decrypt], "secrets")).toEqual([discovery, decrypt]);
});
