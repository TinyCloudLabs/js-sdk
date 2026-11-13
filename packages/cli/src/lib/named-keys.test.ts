import { expect, test } from "bun:test";
import { assertNodeSupportsNamedKeys } from "./named-keys.js";

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
