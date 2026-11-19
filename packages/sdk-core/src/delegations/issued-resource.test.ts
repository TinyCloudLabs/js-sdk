import { expect, test } from "bun:test";
import { queryIssued, revokeIssued } from "./issued";

const did = "did:key:z6MkjkxcrsuBXGxVYAZFC1hPUViiRXLC5Kup4G9aBkFoPimV";
test("issued query uses only its own canonical key space; revoke remains bound to its CID", async () => {
  const signed: unknown[] = [];
  const ctx = {
    host: "http://127.0.0.1:12345", state: { issuedQuerySupported: true },
    sessionInvocationSigner: { did: () => did, sign: async (att: unknown) => { signed.push(att); return "signed"; } },
    fetchFn: async (url: string) => new Response(JSON.stringify(url.endsWith("/revoke") ? { cid: "child", revoked: true } : { schemaVersion: 2, items: [] })),
  };
  expect((await queryIssued(ctx, { direction: "issued" })).ok).toBe(true);
  expect((await revokeIssued(ctx, "child")).ok).toBe(true);
  expect(signed).toEqual([
    { [`tinycloud:key:${did.slice("did:key:".length)}:agent/delegation`]: { "tinycloud.delegation/list": [{}] } },
    { "urn:cid:child": { "tinycloud.delegation/revoke": [{}] } },
  ]);
  ctx.sessionInvocationSigner.did = () => "https://other.example";
  expect((await queryIssued(ctx, { direction: "issued" })).ok).toBe(false);
  expect(signed).toHaveLength(2);
});
