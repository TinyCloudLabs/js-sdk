import { describe, expect, test } from "bun:test";
import { includesDecrypt } from "./decrypt-cap.js";

const entry = (service: string, actions: unknown) => ({ service, space: "default", path: "", actions });

describe("includesDecrypt", () => {
  test.each([
    ["the decrypt action", entry("tinycloud.encryption", ["tinycloud.encryption/decrypt"])],
    ["the encryption wildcard", entry("tinycloud.encryption", ["tinycloud.encryption/*"])],
    ["a short-prefix wildcard", entry("tinycloud.encryption", ["encryption/*"])],
    ["a short-prefix decrypt", entry("tinycloud.encryption", ["encryption/decrypt"])],
    ["a short-prefix decrypt on a short-service entry", entry("encryption", ["encryption/decrypt"])],
    ["a bare decrypt on an encryption entry", entry("encryption", ["decrypt"])],
    ["an unknown action on an encryption entry (fail closed)", entry("tinycloud.encryption", ["tinycloud.encryption/something-new"])],
    ["decrypt among other entries", entry("tinycloud.kv", ["tinycloud.encryption/decrypt"])],
  ])("counts %s", (_name, value) => {
    expect(includesDecrypt([entry("tinycloud.kv", ["tinycloud.kv/get"]), value])).toBe(true);
  });

  test.each([
    ["kv get", entry("tinycloud.kv", ["tinycloud.kv/get"])],
    ["a kv wildcard", entry("tinycloud.kv", ["*"])],
    ["network.create", entry("tinycloud.encryption", ["tinycloud.encryption/network.create"])],
    ["network.revoke, short prefix", entry("tinycloud.encryption", ["encryption/network.revoke"])],
    ["network.create, bare", entry("encryption", ["network.create"])],
    ["a bare decrypt on a kv entry", entry("tinycloud.kv", ["decrypt"])],
  ])("does not count %s", (_name, value) => {
    expect(includesDecrypt([value])).toBe(false);
  });

  test("malformed entries are not decrypt, so request validation can report them", () => {
    expect(includesDecrypt([null, undefined, "x", 3])).toBe(false);
    expect(includesDecrypt([{ service: "tinycloud.encryption" }])).toBe(false);
    expect(includesDecrypt([entry("tinycloud.encryption", "tinycloud.encryption/decrypt")])).toBe(false);
    expect(includesDecrypt([entry("tinycloud.encryption", [null, 3])])).toBe(false);
  });
});
