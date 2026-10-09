/**
 * Differential test (TC-858 §13.2): A1 copied `kvPrefixCovers` and
 * `requiresSecretsOptIn` from `packages/replica/src/scope.ts` into
 * sdk-services so node-sdk never imports replica. This pins the copies to
 * the originals on the same input corpus — a divergence here would let the
 * sign-in gate and the engine disagree about coverage.
 */

import { describe, expect, test } from "bun:test";

import {
  kvPrefixCovers as kvPrefixCoversReplica,
  requiresSecretsOptIn as requiresSecretsOptInReplica,
} from "@tinycloud/replica";
import {
  kvPrefixCovers,
  requiresSecretsOptIn,
} from "@tinycloud/sdk-services";

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
