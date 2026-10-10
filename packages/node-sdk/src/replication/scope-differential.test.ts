/**
 * Differential tests keep the replication coverage helpers aligned with
 * sdk-core capability containment, the authority source of truth.
 */

import { isCapabilitySubset } from "@tinycloud/sdk-core";

import { describe, expect, test } from "bun:test";

import {
  grantCovers,
  kvPrefixCovers as kvPrefixCoversReplica,
  requiresSecretsOptIn as requiresSecretsOptInReplica,
} from "@tinycloud/replica";
import { kvPrefixCovers, requiresSecretsOptIn } from "@tinycloud/sdk-services";

describe("kvPrefixCovers parity with @tinycloud/replica", () => {
  const cases: Array<[string, string]> = [
    ["", "anything"],
    ["", ""],
    ["notes", "notes"],
    ["notes", "notes/a"],
    ["notes", "notes-abc"],
    ["notes", "notes/a/b/c"],
    ["notes/", "notes"],
    ["notes/", "notes/"],
    ["notes/", "notes/a"],
    ["notes/", "notes//double"],
    ["a/b", "a/b/c"],
    ["a/b", "a/bc"],
    ["Vault", "vault/x"],
    ["vault", "vault"],
    ["vault", "vault/keys/a"],
    ["vault", "vaultx"],
    ["notes", ""],
  ];

  for (const [prefix, key] of cases) {
    test(`${JSON.stringify(prefix)} covers ${JSON.stringify(key)}`, () => {
      expect(kvPrefixCovers(prefix, key)).toBe(kvPrefixCoversReplica(prefix, key));
    });
  }
});
 
describe("published segment-aware selection compatibility", () => {
  test("bare notes selects its descendants but not notesX", () => {
    expect(kvPrefixCoversReplica("notes", "notes")).toBe(true);
    expect(kvPrefixCoversReplica("notes", "notes/a")).toBe(true);
    expect(kvPrefixCoversReplica("notes", "notesX")).toBe(false);
    expect(kvPrefixCoversReplica("notes/", "notes")).toBe(false);
    expect(kvPrefixCoversReplica("notes/", "notes/a")).toBe(true);
    expect(kvPrefixCoversReplica("", "anything")).toBe(true);
    expect(kvPrefixCovers("", "anything")).toBe(true);
  });
});

describe("replica grant authority matches sdk-core containment", () => {
  const paths = ["", "/", "notes", "notes/", "notes/private", "notesX", "a/b/", "a/b/c"];
  for (const grantedPath of paths) {
    for (const requestedPath of paths) {
      test(`${JSON.stringify(grantedPath)} → ${JSON.stringify(requestedPath)}`, () => {
        const expected = isCapabilitySubset(
          [{ service: "tinycloud.kv", space: "default", path: requestedPath, actions: ["tinycloud.kv/get"] }],
          [{ service: "tinycloud.kv", space: "default", path: grantedPath, actions: ["tinycloud.kv/get"] }],
        ).subset;
        expect(grantCovers({ att: { [`default/kv/${grantedPath}`]: { "tinycloud.kv/get": {} } } }, "default", requestedPath, "tinycloud.kv/get")).toBe(expected);
      });
    }
  }
});
 

describe("requiresSecretsOptIn parity with @tinycloud/replica", () => {
  const cases: Array<[string, string]> = [
    ["secrets", "anything"],
    ["secrets", "vault/x"],
    ["tinycloud:pkh:eip155:1:0xabc:secrets", "notes"],
    ["tinycloud:pkh:eip155:1:0xabc:secrets", ""],
    ["tinycloud:pkh:eip155:1:0xabc:default", "vault/keys"],
    ["tinycloud:pkh:eip155:1:0xabc:default", "vault"],
    ["tinycloud:pkh:eip155:1:0xabc:default", "vaultx"],
    ["tinycloud:pkh:eip155:1:0xabc:default", "notes/vault/x"],
    ["tinycloud:pkh:eip155:1:0xabc:default", "notes"],
    ["tinycloud:pkh:eip155:1:0xabc:notsecrets", "vault/a"],
    ["default", "secrets"],
    ["mysecrets", "vault/"],
  ];

  for (const [space, prefix] of cases) {
    test(`${space} / ${prefix}`, () => {
      expect(requiresSecretsOptIn(space, prefix)).toBe(
        requiresSecretsOptInReplica(space, prefix),
      );
    });
  }
});
