import "./support/browserGlobalsShim";
import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, spyOn, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node";
import { TinyCloudWeb } from "../src/modules/tcw";
import { SharingService, parseSignedCompactUcanAttenuation } from "@tinycloud/sdk-core";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); });
const path = "vault/secrets/HERMETIC_DELEGATION_CANARY";
async function fixture() {
  const node = await createHermeticEncryptedNode(); stops.push(() => node.stop());
  const sender = new TinyCloudNode({ host: node.host, tinycloudRegistryUrl: node.host, privateKey: node.ownerPrivateKey, autoBootstrapAccount: false });
  await sender.restoreSession(node.ownerRestorableSession);
  node.configureKv(node.ownerRestorableSession.spaceId, { [path]: { message: "private-placement browser smoke" } });
  const made = await sender.sharing.generate({ path, expiry: new Date(Date.now() + 60_000), includePlacement: true });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return { node, sender, share: made.data, decoded: sender.sharing.decodeLink(made.data.token) };
}
function encode(data: unknown) { return "tc1:" + Buffer.from(JSON.stringify(data)).toString("base64url"); }

test("public browser receive uses owner placement and audience-binds its invocation", async () => {
  const f = await fixture();
  const native = globalThis.fetch;
  let authorization: string | null = null;
  let publications = 0;
  const routed = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "registry.tinycloud.xyz") return Promise.resolve(Response.json({ error: "location record not found" }, { status: 404 }));
    if (url.pathname === "/invoke") authorization = new Headers(init?.headers).get("authorization");
    if (init?.method === "PUT" && /\/locations\//.test(url.pathname)) publications++;
    return native(input, init);
  }, { preconnect: native.preconnect }));
  stops.push(() => routed.mockRestore());
  const result = await TinyCloudWeb.receiveShare(encode({ ...f.decoded, host: "https://evil.example" }), path);
  expect(result).toMatchObject({ ok: true, data: { data: { message: "private-placement browser smoke" } } });
  expect(publications).toBe(0);
  expect(authorization).not.toBeNull();
  const signed = parseSignedCompactUcanAttenuation(authorization!);
  expect(signed.payload.aud).toBe(f.decoded.placement!.nodeDid);
  // Independent audience gate for node B: verify the signed invocation before checking its node audience.
  const nodeB = "did:key:z6MkrJVcY6xCzz6qGFmYwNwSuzyLkxEMWrbhtcRbXSRwV7Hn";
  const gate = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const invocation = parseSignedCompactUcanAttenuation(request.headers.get("authorization")!);
    return new Response(null, { status: invocation.payload.aud === nodeB ? 200 : 401 });
  } });
  stops.push(() => gate.stop(true));
  expect((await native(new URL("/invoke", gate.url), { method: "POST", headers: { authorization: authorization! } })).status).toBe(401);
});

test("wrong destination identity refuses before credential I/O", async () => {
  const f = await fixture();
  const native = globalThis.fetch;
  let credentialRequests = 0;
  const routed = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (new Headers(init?.headers).has("authorization")) credentialRequests++;
    if (url.hostname === "registry.tinycloud.xyz") return Promise.resolve(Response.json({ error: "location record not found" }, { status: 404 }));
    if (url.origin === f.node.host && url.pathname === "/info") return Promise.resolve(Response.json({ nodeId: "did:key:wrong" }));
    return native(input, init);
  }, { preconnect: native.preconnect }));
  stops.push(() => routed.mockRestore());
  expect((await TinyCloudWeb.receiveShare(f.share.token, path)).ok).toBe(false);
  expect(credentialRequests).toBe(0);
});


test("placement validation errors never expose private share fields or a cause", async () => {
  const f = await fixture();
  const secret = f.decoded.key.d!;
  const result = await TinyCloudWeb.receiveShare(encode({ ...f.decoded, placement: { ...f.decoded.placement, type: secret } }), path);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("invalid placement unexpectedly accepted");
  expect(result.error.code).toBe("DECODE_FAILED");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.error).not.toHaveProperty("cause");
});

test("activation refusals never expose an echoed parent credential or a cause", async () => {
  const f = await fixture();
  const native = globalThis.fetch;
  const routed = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "registry.tinycloud.xyz") return Promise.resolve(Response.json({ error: "location record not found" }, { status: 404 }));
    if (url.origin === f.node.host && url.pathname === "/delegate") return Promise.resolve(new Response(new Headers(init?.headers).get("authorization"), { status: 403 }));
    return native(input, init);
  }, { preconnect: native.preconnect }));
  stops.push(() => routed.mockRestore());
  const result = await TinyCloudWeb.receiveShare(f.share.token, path);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("refused delegation unexpectedly accepted");
  expect(result.error.code).toBe("DELEGATION_FAILED");
  expect(JSON.stringify(result)).not.toContain(f.decoded.delegation.authHeader!);
  expect(result.error).not.toHaveProperty("cause");
});


test("the Web catch redacts a secret-bearing non-placement exception", async () => {
  const f = await fixture();
  const secret = f.decoded.key.d!;
  const failure = Object.assign(new Error(secret), { cause: { authorization: f.decoded.delegation.authHeader } });
  const receive = spyOn(SharingService.prototype, "receive").mockRejectedValue(failure);
  stops.push(() => receive.mockRestore());
  const result = await TinyCloudWeb.receiveShare(f.share.token, path);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("failed transport unexpectedly accepted");
  expect(result.error).toEqual({ code: "DECODE_FAILED", message: "Could not process the sharing link.", service: "delegation" });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.error).not.toHaveProperty("cause");
});
