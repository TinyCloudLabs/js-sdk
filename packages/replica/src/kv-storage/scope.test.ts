import { expect, test } from "bun:test";

import { assertBrowserReadThroughScope } from "../scope.js";

test("browser replica refuses secrets, vault and whole-space scopes regardless of opt-in", () => {
  for (const [space, prefix, allowSecrets] of [
    ["did:key:zspace", "notes/", true],
    ["secrets", "notes/", false],
    ["did:key:zspace:secrets", "notes/", false],
    ["did:key:zspace", "secrets/", false],
    ["did:key:zspace", "vault/", false],
    ["did:key:zspace", "/", false],
    ["secrets", "vault/", true],
  ] as const) {
    expect(() => assertBrowserReadThroughScope(space, prefix, allowSecrets)).toThrow(
      expect.objectContaining({ code: "REPLICA_INVALID_ARGUMENT" }),
    );
  }
});

test("browser replica accepts only ordinary folder prefixes without opt-in", () => {
  expect(() => assertBrowserReadThroughScope("did:key:zspace", "notes/", false)).not.toThrow();
  expect(() => assertBrowserReadThroughScope("did:key:zspace", "notes/vault/", false)).not.toThrow();
});
