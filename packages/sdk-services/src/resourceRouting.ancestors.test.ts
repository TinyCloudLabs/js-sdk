import { describe, expect, test } from "bun:test";
import { createResourceRoutingFetch, isVaultResourceUri, namesVaultResourceUri } from "./resourceRouting";

// TC-2944: a request or grant that reaches vault data from above (the whole
// key space, or a whole space) is vault traffic too. Node requests are not.
const owner = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const ability = { "tinycloud.kv/list": [{}] };

async function routedEndToEnd(att: Record<string, Record<string, unknown[]>>): Promise<boolean | undefined> {
  let seen: boolean | undefined;
  const fetch = createResourceRoutingFetch(async () => new Response("ciphertext"), {
    resolveResource: async (_resource, _access, _dataRead, endToEnd) => {
      seen = endToEnd;
      return [{ url: "http://127.0.0.1:19901" }];
    },
    bindAudience: async (value) => value,
  });
  const authorization = ["header", btoa(JSON.stringify({ iss: "did:key:session", att })), "signature"].join(".");
  await fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: authorization } });
  return seen;
}

describe("requests and grants that reach vault data from above", () => {
  test.each([
    ["the key-space root", `${owner}:default/kv`],
    ["the key-space root with a slash", `${owner}:default/kv/`],
    ["the key-space root of an apps space", `${owner}:apps/kv/`],
    ["the vault namespace with a query", `${owner}:default/kv/vault?limit=1`],
    ["a vault value with a fragment", `${owner}:default/kv/vault/api-key#v1`],
    ["a dot segment into the vault", `${owner}:default/kv/./vault/api-key`],
    ["a parent segment into the vault", `${owner}:default/kv/notes/../vault/api-key`],
    ["an empty segment before the vault", `${owner}:default/kv//vault/api-key`],
    ["an escaped vault name", `${owner}:default/kv/%76ault/api-key`],
  ])("%s is vault", (_label, uri) => {
    expect(isVaultResourceUri(uri)).toBe(true);
  });

  test.each([
    ["a kv ability", { "tinycloud.kv/get": [{}] }],
    ["a wildcard ability", { "tinycloud.*": [{}] }],
    ["an ability of a future service", { "tinycloud.future/read": [{}] }],
    ["abilities listed as an array", ["tinycloud.kv/list"]],
    ["abilities of an unreadable shape", "tinycloud.kv/list"],
  ])("a space root carrying %s is vault", (_label, abilities) => {
    expect(isVaultResourceUri(`${owner}:default`, abilities)).toBe(true);
  });

  test.each([
    ["a bare space id", `${owner}:default`, undefined],
    ["a space root that is only hosted", `${owner}:default`, { "tinycloud.space/host": [{}] }],
    ["a space root read for capabilities and info", `${owner}:default/`, { "tinycloud.capabilities/read": [{}], "tinycloud.space/info": [{}] }],
    ["ordinary data", `${owner}:default/kv/notes`, undefined],
    ["ordinary data under a trailing slash", `${owner}:default/kv/notes/`, undefined],
    ["a name that only starts like a vault namespace", `${owner}:default/kv/vaulted`, undefined],
    ["a vault-named path under another prefix", `${owner}:default/kv/apps/vault`, undefined],
    ["a vault-named sql database", `${owner}:default/sql/vault`, undefined],
    ["the sql root", `${owner}:default/sql`, undefined],
    ["a node-local name", "tinycloud://node.example/kv/", undefined],
    ["a node-local name with a vault path", "tinycloud://node.example/kv/vault/api-key", undefined],
    ["a node-local name that ends in secrets", "tinycloud://node:secrets/kv/", undefined],
    ["an encryption network", "urn:tinycloud:encryption:did:key:zOwner:default", { "tinycloud.encryption/decrypt": [{}] }],
  ])("%s is not vault", (_label, uri, abilities) => {
    expect(isVaultResourceUri(uri, abilities)).toBe(false);
  });

  test("a root list invocation is routed end-to-end", async () => {
    expect(await routedEndToEnd({ [`${owner}:default/kv/`]: ability })).toBe(true);
    expect(await routedEndToEnd({ [`${owner}:default/kv`]: ability })).toBe(true);
  });

  test("a space-root invocation is routed end-to-end only with a kv ability", async () => {
    expect(await routedEndToEnd({ [owner + ":default"]: ability })).toBe(true);
    expect(await routedEndToEnd({ [owner + ":default"]: { "tinycloud.space/host": [{}] } })).toBe(false);
  });

  test("node requests and other services keep ordinary routing", async () => {
    expect(await routedEndToEnd({ "tinycloud://node.example/kv/": ability })).toBe(false);
    expect(await routedEndToEnd({ [`${owner}:default/sql/vault`]: { "tinycloud.sql/read": [{}] } })).toBe(false);
    expect(await routedEndToEnd({ [`${owner}:default/kv/notes`]: ability })).toBe(false);
  });
});

describe("names of vault data, as a session's own grant is classified", () => {
  test.each([
    ["a vault value", `${owner}:default/kv/vault/api-key`],
    ["the vault listing", `${owner}:default/kv/vault/`],
    ["a legacy vault key", `${owner}:apps/kv/keys/api-key`],
    ["the secrets space", `${owner}:secrets/kv/`],
    ["a dot segment into the vault", `${owner}:default/kv/./vault/api-key`],
  ])("%s is named", (_label, uri) => {
    expect(namesVaultResourceUri(uri)).toBe(true);
  });

  test.each([
    ["the key-space root", `${owner}:default/kv/`],
    ["the key-space root without a slash", `${owner}:default/kv`],
    ["a space root", `${owner}:default`],
    ["ordinary data", `${owner}:default/kv/notes`],
    ["a node-local name", "tinycloud://node.example/kv/vault/api-key"],
  ])("%s names none", (_label, uri) => {
    expect(namesVaultResourceUri(uri)).toBe(false);
  });
});
