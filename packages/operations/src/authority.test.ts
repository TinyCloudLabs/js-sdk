import { expect, test } from "bun:test";

import {
  canonicalizeCapabilities,
  evaluateAuthority,
  permissionIdentity,
} from "./authority.js";

const keyGet = {
  service: "tinycloud.kv",
  space: "secrets",
  path: "vault/secrets/API_KEY",
  actions: ["tinycloud.kv/get"],
};

const keyPut = {
  ...keyGet,
  actions: ["tinycloud.kv/put"],
};

test("evaluates only the exact missing subset with the SDK's public containment semantics", () => {
  const result = evaluateAuthority(
    [{
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/",
      actions: ["tinycloud.kv/*"],
    }],
    [keyPut, keyGet],
  );

  expect(result).toEqual({
    satisfied: true,
    missing: [],
  });

  const missing = evaluateAuthority([keyGet], [keyPut, keyGet]);
  expect(missing).toEqual({
    satisfied: false,
    missing: [keyPut],
  });
});

test("canonicalizes, sorts, and deduplicates exact capability identities without broadening them", () => {
  const required = [
    {
      ...keyGet,
      actions: ["tinycloud.kv/put", "tinycloud.kv/get", "tinycloud.kv/get"],
    },
    {
      ...keyGet,
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    },
    {
      service: "tinycloud.kv",
      space: "other-space",
      path: "vault/secrets/API_KEY",
      actions: ["tinycloud.kv/get"],
    },
  ];

  expect(canonicalizeCapabilities(required)).toEqual([
    {
      service: "tinycloud.kv",
      space: "other-space",
      path: "vault/secrets/API_KEY",
      actions: ["tinycloud.kv/get"],
    },
    {
      ...keyGet,
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    },
  ]);

  const result = evaluateAuthority([], required);
  expect(result.missing).toEqual(canonicalizeCapabilities(required));
  expect(result.missing.some((entry) => entry.actions.some((action) => action.includes("*")))).toBe(false);
});

test("keeps resource scopes in the exact canonical identity", () => {
  expect(permissionIdentity(keyGet)).not.toBe(permissionIdentity({ ...keyGet, space: "other-space" }));
  expect(permissionIdentity(keyGet)).not.toBe(permissionIdentity({ ...keyGet, path: "vault/secrets/" }));
  expect(permissionIdentity(keyGet)).not.toBe(permissionIdentity(keyPut));
});
