import { describe, expect, test } from "bun:test";
import { assertNodeSupportsNamedKeys, keyAbilitiesFor, parseKeysPrefix } from "./named-keys.js";

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

describe("parseKeysPrefix", () => {
  test("qa and qa/ give the same grant", () => {
    const bare = parseKeysPrefix("qa", OWNER);
    const slash = parseKeysPrefix("qa/", OWNER);
    expect(bare).toEqual(slash);
    expect(bare.resource).toBe(`urn:tinycloud:encryption:${OWNER}:default/qa/`);
    expect(keyAbilitiesFor(bare)).toEqual({
      [bare.resource]: ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"],
    });
  });

  test.each([
    ["/qa"],
    ["qa//x"],
    ["QA"],
    ["apps"],
    ["apps/x"],
    [""],
  ])("%p is refused as a usage error (exit 2)", (input) => {
    let thrown: unknown;
    try {
      parseKeysPrefix(input, OWNER);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INVALID_KEY_PREFIX", exitCode: 2 });
  });
});

test("the named-key preflight reads the production node's TEE origin and refuses redirects; other hosts keep their origin", async () => {
  const seen: { url: string; redirect?: RequestRedirect }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, redirect: init?.redirect });
    return Response.json({ features: ["encryption-named-keys-v1"] });
  }) as unknown as typeof fetch;
  for (const host of ["https://node.tinycloud.xyz", "https://tee.node.tinycloud.xyz", "http://127.0.0.1:8000"]) {
    await assertNodeSupportsNamedKeys(host, fetchImpl);
  }
  expect(seen).toEqual([
    { url: "https://tee.node.tinycloud.xyz/info", redirect: "error" },
    { url: "https://tee.node.tinycloud.xyz/info", redirect: "error" },
    { url: "http://127.0.0.1:8000/info", redirect: "error" },
  ]);
});
