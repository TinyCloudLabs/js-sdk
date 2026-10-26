import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerIdentitySigner, startOwnerRevocationHandoff, startPreparedOpenKeyHandoff } from "./prepared-openkey.js";

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

test("owner revocation tv2 carries the proposed request and returns only signed SIWE and signature", async () => {
  const request = { kind: "owner-revocation" as const, ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
    cid: "bafytest", nonce: "1234567890abcdef", expiresAt: "2026-10-26T12:10:00.000Z" };
  const flow = await startOwnerRevocationHandoff({ request, openKeyHost: "http://openkey.local", noPopup: true });
  const encoded = new URL(flow.url).hash.slice("#tv2=".length);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  expect(payload.transportVersion).toBe(2);
  expect(payload.request).toEqual(request);
  const signed = { siwe: "OpenKey-built plain SIWE", signature: "0xsigned" };
  const send = (state: string, result: object) => fetch(payload.delivery.callback, {
    method: "POST", headers: { Origin: "http://openkey.local", "Content-Type": "application/json" },
    body: JSON.stringify({ transportVersion: 2, state, result }),
  });
  expect((await send("B".repeat(43), signed)).status).toBe(403);
  const callback = send(payload.delivery.state, signed);
  expect(await flow.result).toEqual(signed);
  await flow.complete(true);
  expect((await callback).status).toBe(200);
});

test("the callback rejects wrong origin or state and ACKs only after SDK/session commit", async () => {
  const flow = await startPreparedOpenKeyHandoff({
    prepared: { protocolVersion: 1, siwe: "original SDK SIWE", jwk: { kty: "OKP", crv: "Ed25519", x: "public", d: "private" },
      host: "https://node.example", verificationMethod: "did:key:z6MkPrepared#z6MkPrepared" },
    openKeyHost: "http://openkey.local", noPopup: true, paste: false,
  });
  const handoff = JSON.parse(Buffer.from(new URL(flow.url).hash.slice("#tv2=".length), "base64url").toString("utf8")) as {
    delivery: { callback: string; state: string }; request: { jwk: Record<string, unknown> };
  };
  expect(handoff.request.jwk).toEqual({ kty: "OKP", crv: "Ed25519", x: "public" });
  const post = (origin: string, state: string) => fetch(handoff.delivery.callback, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ transportVersion: 2, state, selectedKeyId: "key-1", result }),
  });
  expect((await post("http://attacker.local", handoff.delivery.state)).status).toBe(403);
  const preflight = await fetch(handoff.delivery.callback, {
    method: "OPTIONS",
    headers: { Origin: "http://openkey.local", "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type", "Access-Control-Request-Private-Network": "true" },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
  expect((await post("http://openkey.local", "B".repeat(43))).status).toBe(403);
  let acknowledged = false;
  const callback = post("http://openkey.local", handoff.delivery.state).then((response) => {
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

// The shipped CLI runs on Node, whose HTTP server keeps a connection that
// never sent a request alive after `close()`; Bun's does not, so this runs the
// handoff in a Node subprocess and requires it to exit by itself.
const NODE_HARNESS = `
import { connect } from "node:net";
const { startPreparedOpenKeyHandoff } = await import(process.argv[2]);
const result = ${JSON.stringify(result)};
const flow = await startPreparedOpenKeyHandoff({
  prepared: { protocolVersion: 1, siwe: "original SDK SIWE", jwk: { kty: "OKP", crv: "Ed25519", x: "public", d: "private" },
    host: "https://node.example", verificationMethod: "did:key:z6MkPrepared#z6MkPrepared" },
  openKeyHost: "http://openkey.local", noPopup: true, paste: false,
});
const handoff = JSON.parse(Buffer.from(new URL(flow.url).hash.slice(5), "base64url").toString("utf8"));
const callback = new URL(handoff.delivery.callback);
// Chromium's Local Network Access refusal connects first, then never sends a request.
const idle = connect(Number(callback.port), callback.hostname);
await new Promise((resolve) => idle.once("connect", resolve));
idle.on("error", () => {});
const ack = fetch(callback, { method: "POST", headers: { Origin: "http://openkey.local", "Content-Type": "application/json" },
  body: JSON.stringify({ transportVersion: 2, state: handoff.delivery.state, result }) });
await flow.result;
await flow.complete(true);
const receipt = await ack;
process.stdout.write(JSON.stringify({ status: receipt.status, body: await receipt.json() }));
`;

test("a completed handoff exits under Node even when a browser left an idle callback connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc1287-node-handoff-"));
  try {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "prepared-openkey.ts")], target: "node", format: "esm",
      outdir: directory, naming: "handoff.mjs" });
    expect(built.success).toBe(true);
    await writeFile(join(directory, "harness.mjs"), NODE_HARNESS);
    const child = Bun.spawn(["node", join(directory, "harness.mjs"), join(directory, "handoff.mjs")],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    // Real time is the subject: the process must exit on its own.
    const deadline = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => deadline.resolve("timeout"), 8_000);
    const exit = await Promise.race([child.exited, deadline.promise]);
    clearTimeout(timer);
    if (exit === "timeout") child.kill("SIGKILL");
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ status: 200, body: { accepted: true } });
    expect(exit).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a mismatched selected key never settles the handoff; failed SDK verification returns non-ACK", async () => {
  const api = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
  servers.push(api);
  const flow = await startPreparedOpenKeyHandoff({
    prepared: { protocolVersion: 1, siwe: "original SDK SIWE", jwk: { kty: "OKP", crv: "Ed25519", x: "public" },
      host: "https://node.example", keyId: "requested", verificationMethod: "did:key:z6MkPrepared#z6MkPrepared" },
    openKeyHost: "http://openkey.local", apiHost: api.url.origin, noPopup: true,
  });
  const handoff = JSON.parse(Buffer.from(new URL(flow.url).hash.slice("#tv2=".length), "base64url").toString("utf8")) as {
    delivery: { callback: string; state: string };
  };
  const post = (selectedKeyId: string) => fetch(handoff.delivery.callback, {
    method: "POST", headers: { Origin: "http://openkey.local", "Content-Type": "application/json" },
    body: JSON.stringify({ transportVersion: 2, state: handoff.delivery.state, selectedKeyId, result }),
  });
  expect((await post("another")).status).toBe(403);
  const callback = post("requested");
  expect(await flow.result).toEqual(result);
  await flow.complete(false);
  expect((await callback).status).toBe(422);
});


test("an OpenKey owner identity can prepare SIWE but cannot counterfeit a wallet revocation signature", async () => {
  const signer = ownerIdentitySigner("did:pkh:eip155:1:0xe8c2ab8468210C4b507C0563A10da60990eaa792");
  expect(await signer.getAddress()).toBe("0xe8c2ab8468210C4b507C0563A10da60990eaa792");
  expect(await signer.getChainId()).toBe(1);
  await expect(signer.signMessage("owner revocation")).rejects.toMatchObject({ code: "REVOCATION_AUTHORITY_UNAVAILABLE" });
  expect(() => ownerIdentitySigner("did:pkh:eip155:9007199254740993:0xe8c2ab8468210C4b507C0563A10da60990eaa792"))
    .toThrow();
});

test("v2 embeds only public prepared authority in a bounded fragment without anonymous registration", async () => {
  const requests: string[] = [];
  const api = Bun.serve({ port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return Response.json({ transportVersion: 2, ticket: "A".repeat(43),
      expiresAt: new Date(Date.now() + 300_000).toISOString() }, { status: 201 });
  } });
  servers.push(api);
  const flow = await startPreparedOpenKeyHandoff({
    prepared: { protocolVersion: 1, siwe: "original SDK SIWE",
      jwk: { kty: "OKP", crv: "Ed25519", x: "public", d: "private" },
      host: "https://node.example", verificationMethod: "did:key:z6MkPrepared#z6MkPrepared" },
    openKeyHost: "https://openkey.so", apiHost: api.url.origin, noPopup: true,
  });
  try {
    expect(requests).toEqual([]);
    const url = new URL(flow.url);
    expect(url.pathname).toBe("/delegate");
    expect(url.search).toBe("");
    expect(Buffer.byteLength(url.href)).toBeLessThanOrEqual(8192);
    const envelope = JSON.parse(Buffer.from(url.hash.slice("#tv2=".length), "base64url").toString("utf8")) as {
      transportVersion: number; request: { siwe: string; jwk: Record<string, unknown>; sessionDid: string };
      delivery: { handoffId: string; state: string; cancelSecret: string; callback: string };
    };
    expect(envelope.transportVersion).toBe(2);
    expect(envelope.request).toMatchObject({ siwe: "original SDK SIWE",
      jwk: { kty: "OKP", crv: "Ed25519", x: "public" }, sessionDid: "did:key:z6MkPrepared#z6MkPrepared" });
    expect(envelope.request.jwk).not.toHaveProperty("d");
    expect(new Set([envelope.delivery.handoffId, envelope.delivery.state, envelope.delivery.cancelSecret]).size).toBe(3);
    expect(envelope.delivery.callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]{22}$/);
  } finally {
    await flow.complete(false);
  }
});

test("overlong prepared SIWE refuses the fragment rather than falling back to legacy approval", async () => {
  let flow: Awaited<ReturnType<typeof startPreparedOpenKeyHandoff>> | undefined;
  try {
    flow = await startPreparedOpenKeyHandoff({
      prepared: { protocolVersion: 1, siwe: "x".repeat(8192),
        jwk: { kty: "OKP", crv: "Ed25519", x: "public", d: "private" },
        host: "https://node.example", verificationMethod: "did:key:z6MkPrepared#z6MkPrepared" },
      openKeyHost: "https://openkey.so", apiHost: "http://127.0.0.1:1", noPopup: true,
    });
    throw new Error("An oversized handoff unexpectedly started");
  } catch (error) {
    expect(error).toMatchObject({ code: "V2_URL_TOO_LONG" });
  } finally {
    await flow?.complete(false);
  }
});

test("headless callback expiry exits with a Safari paste retry hint and invalidates its state", async () => {
  const api = Bun.serve({ port: 0, fetch: () => Response.json({ cancelled: true }) });
  servers.push(api);
  // A short real expiry: Bun's fake timers stall this flow's sockets.
  const flow = await startPreparedOpenKeyHandoff({
    prepared: { protocolVersion: 1, siwe: "original SDK SIWE", jwk: { kty: "OKP", crv: "Ed25519", x: "public", d: "private" },
      host: "https://node.example", verificationMethod: "did:key:z6MkPrepared#z6MkPrepared" },
    openKeyHost: "https://openkey.test", apiHost: api.url.origin, noPopup: true, expiryMs: 20,
  });
  const callback = JSON.parse(Buffer.from(new URL(flow.url).hash.slice("#tv2=".length), "base64url").toString("utf8")).delivery.callback as string;
  await expect(flow.result).rejects.toMatchObject({
    code: "V2_EXPIRED", message: expect.stringContaining("Re-run with --paste (Safari may require it)"),
  });
  await expect(fetch(callback, {
    method: "POST", headers: { Origin: "https://openkey.test", "Content-Type": "application/json" },
    body: JSON.stringify({ transportVersion: 2, state: "A".repeat(43), result }),
  })).rejects.toThrow();
});
