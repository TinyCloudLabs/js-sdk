import { describe, expect, test } from "bun:test";
import { createResourceRoutingFetch, createResourceTransportInvocationFetch, type ResourceTransportOptions } from "./resourceRouting";
import type { ServiceSession } from "./types";

// TC-2944: vault values and names may only use end-to-end origins, so every
// invocation that touches them is routed with `endToEnd`.
const owner = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const token = (uri: string, action = "tinycloud.kv/get") =>
  ["header", btoa(JSON.stringify({ iss: "did:key:session", att: { [uri]: { [action]: [{}] } } })), "signature"].join(".");

async function routedEndToEnd(authorization: string): Promise<boolean | undefined> {
  let seen: boolean | undefined;
  const fetch = createResourceRoutingFetch(async () => new Response("ciphertext"), {
    resolveResource: async (_resource, _access, _dataRead, endToEnd) => {
      seen = endToEnd;
      return [{ url: "http://127.0.0.1:19901" }];
    },
    bindAudience: async (value) => value,
  });
  await fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: authorization } });
  return seen;
}

describe("end-to-end routing of vault traffic", () => {
  test.each([
    ["a vault value", `${owner}:default/kv/vault/api-key`],
    ["the vault listing", `${owner}:default/kv/vault/`],
    ["a legacy vault key", `${owner}:apps/kv/keys/api-key`],
    ["a legacy vault grant", `${owner}:apps/kv/grants/did:key:z6Mk/api-key`],
    ["any path in the secrets space", `${owner}:secrets/kv/notes`],
    ["the secrets space root listing", `${owner}:secrets/kv/`],
  ])("%s is end-to-end", async (_label, uri) => {
    expect(await routedEndToEnd(token(uri))).toBe(true);
  });

  test.each([
    ["ordinary data", `${owner}:default/kv/notes`],
    ["a name that only starts like a vault namespace", `${owner}:default/kv/vaulted/notes`],
    ["a vault-named path under another prefix", `${owner}:default/kv/apps/vault/notes`],
    ["a space whose name ends in secrets", `${owner}:mysecrets/kv/notes`],
  ])("%s keeps ordinary routing", async (_label, uri) => {
    expect(await routedEndToEnd(token(uri))).toBe(false);
  });

  test("one vault resource makes the whole invocation end-to-end", async () => {
    const authorization = ["header", btoa(JSON.stringify({
      iss: "did:key:session",
      att: {
        [`${owner}:default/kv/notes`]: { "tinycloud.kv/get": [{}] },
        [`${owner}:default/kv/vault/api-key`]: { "tinycloud.kv/get": [{}] },
      },
    })), "signature"].join(".");
    expect(await routedEndToEnd(authorization)).toBe(true);
  });

  test("share-session invocations carry the same decision to the transport", async () => {
    const seen: Array<ResourceTransportOptions | undefined> = [];
    const fetch = createResourceTransportInvocationFetch(async (_resources, _send, options) => {
      seen.push(options);
      return new Response("ciphertext");
    }, {} as ServiceSession);
    await fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: token(`${owner}:default/kv/vault/api-key`) } });
    await fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: token(`${owner}:default/kv/notes`) } });
    expect(seen.map((options) => options?.endToEnd)).toEqual([true, false]);
  });
});
