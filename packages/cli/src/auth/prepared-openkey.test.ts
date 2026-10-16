import { afterEach, expect, test } from "bun:test";
import { startPreparedOpenKeyHandoff } from "./prepared-openkey.js";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

const result = {
  protocolVersion: 1 as const,
  address: "0x0000000000000000000000000000000000000001",
  signature: "0xsigned",
  signedMessage: "original signed SIWE",
  selectedActionKeys: ["kv:get"],
  permissions: [],
};

test("the callback rejects wrong origin or state and ACKs only after SDK/session commit", async () => {
  let handoff: { delivery: { callback: string; state: string }; request: { jwk: Record<string, unknown> } } | undefined;
  const api = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/api/delegate/handoffs") return new Response(null, { status: 404 });
    handoff = await request.json() as typeof handoff;
    return Response.json({ transportVersion: 2, ticket: "A".repeat(43), expiresAt: new Date(Date.now() + 300_000).toISOString() }, { status: 201 });
  } });
  servers.push(api);
  const flow = await startPreparedOpenKeyHandoff({
    prepared: { protocolVersion: 1, siwe: "original SDK SIWE", jwk: { kty: "OKP", crv: "Ed25519", x: "public", d: "private" },
      host: "https://node.example", verificationMethod: "did:key:z6MkPrepared#z6MkPrepared" },
    openKeyHost: "http://openkey.local", apiHost: api.url.origin, noPopup: true, paste: false,
  });
  expect(handoff?.request.jwk).toEqual({ kty: "OKP", crv: "Ed25519", x: "public" });
  const post = (origin: string, state: string) => fetch(handoff!.delivery.callback, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ transportVersion: 2, state, selectedKeyId: "key-1", result }),
  });
  expect((await post("http://attacker.local", handoff!.delivery.state)).status).toBe(403);
  expect((await post("http://openkey.local", "B".repeat(43))).status).toBe(403);
  let acknowledged = false;
  const callback = post("http://openkey.local", handoff!.delivery.state).then((response) => {
    acknowledged = true;
    return response;
  });
  expect(await flow.result).toEqual(result);
  expect(acknowledged).toBe(false);
  await flow.complete(true);
  const receipt = await callback;
  expect(receipt.status).toBe(200);
  expect(await receipt.json()).toEqual({ accepted: true });
});

test("a mismatched selected key never settles the handoff; failed SDK verification returns non-ACK", async () => {
  let handoff: { delivery: { callback: string; state: string } } | undefined;
  const api = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/delegate/handoffs") {
      handoff = await request.json() as typeof handoff;
      return Response.json({ transportVersion: 2, ticket: "A".repeat(43), expiresAt: new Date(Date.now() + 300_000).toISOString() }, { status: 201 });
    }
    return new Response(null, { status: 204 });
  } });
  servers.push(api);
  const flow = await startPreparedOpenKeyHandoff({
    prepared: { protocolVersion: 1, siwe: "original SDK SIWE", jwk: { kty: "OKP", crv: "Ed25519", x: "public" },
      host: "https://node.example", keyId: "requested", verificationMethod: "did:key:z6MkPrepared#z6MkPrepared" },
    openKeyHost: "http://openkey.local", apiHost: api.url.origin, noPopup: true,
  });
  const post = (selectedKeyId: string) => fetch(handoff!.delivery.callback, {
    method: "POST", headers: { Origin: "http://openkey.local", "Content-Type": "application/json" },
    body: JSON.stringify({ transportVersion: 2, state: handoff!.delivery.state, selectedKeyId, result }),
  });
  expect((await post("another")).status).toBe(403);
  const callback = post("requested");
  expect(await flow.result).toEqual(result);
  await flow.complete(false);
  expect((await callback).status).toBe(422);
});
