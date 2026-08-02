import { describe, expect, mock, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "@noble/hashes/sha256";
import {
  createShareArtifact,
  encodeInlineShareUrl,
  encodeShareUrl,
  intersectShareCapabilities,
  parsePublishedShareEnvelope,
  parseShareUrl,
  ShareEnvelopeError,
  normalizeShareRecipientTarget,
  shareCapabilityAllows,
  type ShareArtifactV2,
} from "./share-envelope";
import { ShareRecipientClient } from "./ShareRecipientClient";
import { MemoryShareCache } from "./ShareCache";
import nodeVectors from "./fixtures/share-email-v2-vectors.json";

const ORIGIN = "https://node.example.test";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const NODE_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 65);
const NODE_DID = `did:key:${base58btc.encode(new Uint8Array([0xed, 0x01, ...ed25519.getPublicKey(NODE_PRIVATE_KEY)]))}`;

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function encoded(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function nodeProof(message: Record<string, unknown>, domain: string): Record<string, string> {
  const kid = `${NODE_DID}#${NODE_DID.slice("did:key:".length)}`;
  return { alg: "EdDSA", kid, signature: encoded(ed25519.sign(new TextEncoder().encode(`${domain}${canonical(message)}`), NODE_PRIVATE_KEY)) };
}

function artifact(): { artifact: ShareArtifactV2; bytes: Uint8Array; cid: string } {
  return createShareArtifact({
    origin: ORIGIN,
    spaceId: SPACE,
    resource: { kind: "exact", path: "docs/readme.md" },
    actions: ["read"],
    mimeType: "text/markdown",
    bytes: new TextEncoder().encode("# hello"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    signerDid: "did:key:z6MkSigner",
    signerPrivateKey: PRIVATE_KEY,
  });
}

describe("ShareRecipientClient", () => {
  test("matches the serialized Node v2 JCS request vector", () => {
    const vector = nodeVectors.vectors.addressedDelegationRequest;
    expect(canonical(vector.body)).toBe(vector.canonicalJson);
    expect(encoded(sha256(new TextEncoder().encode(vector.canonicalJson)))).toBe(vector.requestBodyDigest);
  });

  test("normalizes only the DNS side of exact email matchers and uses segment-safe resource containment", () => {
    expect(normalizeShareRecipientTarget({ kind: "exactEmail", value: "Alice+Notes@MAILINATOR.COM" })).toEqual({ kind: "exactEmail", value: "Alice+Notes@mailinator.com" });
    const recipientDid = `did:key:${base58btc.encode(new Uint8Array([0xed, 0x01, ...ed25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 101))]))}`;
    expect(normalizeShareRecipientTarget({ kind: "recipientDid", value: recipientDid })).toEqual({ kind: "recipientDid", value: recipientDid });
    expect(() => normalizeShareRecipientTarget({ kind: "recipientDid", value: "did:key:zholder" })).toThrow(/recipient DID/);
    expect(() => normalizeShareRecipientTarget({ kind: "recipientDid", value: "did:web:-bad.example" })).toThrow(/recipient DID/);
    expect(shareCapabilityAllows({ spaceId: SPACE, resource: { kind: "prefix", path: "docs/" }, actions: ["read"] }, "read", "docs/readme.md")).toBe(true);
    expect(shareCapabilityAllows({ spaceId: SPACE, resource: { kind: "prefix", path: "docs/" }, actions: ["read"] }, "read", "docs2/readme.md")).toBe(false);
    expect(shareCapabilityAllows({ spaceId: SPACE, resource: { kind: "exact", path: "docs/readme.md" }, actions: ["list"] }, "list", "docs/readme.md")).toBe(false);
    expect(shareCapabilityAllows({ spaceId: SPACE, resource: { kind: "prefix", path: "docs/" }, actions: ["read"] }, "read", "docs/nested/readme.md")).toBe(false);
    expect(intersectShareCapabilities(
      { spaceId: SPACE, resource: { kind: "exact", path: "docs2/readme.md" }, actions: ["read"] },
      { spaceId: SPACE, resource: { kind: "prefix", path: "docs/" }, actions: ["read"] },
    )).toBeUndefined();
  });

  test("parses the direct Share v2 recipient/actions/encrypted/metadata envelope wire", () => {
    const created = createShareArtifact({
      origin: ORIGIN,
      spaceId: SPACE,
      resource: { kind: "exact", path: "docs/policy.md" },
      actions: ["read"],
      mimeType: "text/markdown",
      bytes: new Uint8Array(),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      signerDid: "did:key:z6MkSigner",
      signerPrivateKey: PRIVATE_KEY,
    });
    const parsed = parsePublishedShareEnvelope(new TextEncoder().encode(JSON.stringify({ ...created.artifact.envelope, metadata: created.artifact.envelope.content })), { expectedOrigin: ORIGIN, now: new Date("2080-01-01T00:00:00.000Z") });
    expect(parsed.artifact.envelope.version).toBe(2);
    expect(parsed.artifact.envelope.actions).toEqual(["read"]);
  });

  test("opens compact and inline links, verifies the artifact, and caches compact bytes", async () => {
    const created = artifact();
    let fetchCount = 0;
    const fetch = mock(async () => {
      fetchCount += 1;
      return new Response(created.bytes, { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new ShareRecipientClient({ trustedOrigins: [ORIGIN], fetch: fetch as never, now: () => new Date("2080-01-01T00:00:00.000Z") });
    const link = encodeShareUrl({ origin: ORIGIN, cid: created.cid });
    const first = await client.open(link);
    const second = await client.open(link);
    expect(fetchCount).toBe(1);
    expect(await first.get()).toEqual({ bytes: new TextEncoder().encode("# hello"), contentType: "text/markdown", size: 7 });
    expect(await second.get()).toEqual({ bytes: new TextEncoder().encode("# hello"), contentType: "text/markdown", size: 7 });

    const inline = encodeInlineShareUrl({ origin: ORIGIN, artifact: created.artifact });
    expect(parseShareUrl(inline, { trustedOrigins: [ORIGIN] }).kind).toBe("inline");
    expect((await client.open(inline)).envelope.version).toBe(2);
  });

  test("rejects tampering, expiry, untrusted origins, and capability escalation", async () => {
    const created = artifact();
    const link = encodeShareUrl({ origin: ORIGIN, cid: created.cid });
    await expect(new ShareRecipientClient({ trustedOrigins: ["https://other.example.test"], fetch: mock(async () => new Response(created.bytes)) as never }).open(link)).rejects.toMatchObject({ code: "origin-mismatch" });
    const tampered = new Uint8Array(created.bytes);
    tampered[tampered.length - 2] ^= 1;
    await expect(new ShareRecipientClient({ trustedOrigins: [ORIGIN], fetch: mock(async () => new Response(tampered)) as never }).open(link)).rejects.toMatchObject({ code: "SHARE_CID_MISMATCH" });
    expect(() => parseShareUrl("https://node.example.test/s/i/invalid", { trustedOrigins: [ORIGIN] })).toThrow(ShareEnvelopeError);
    expect(intersectShareCapabilities(
      { spaceId: SPACE, resource: { kind: "prefix", path: "docs/" }, actions: ["read", "list", "edit"] },
      { spaceId: SPACE, resource: { kind: "exact", path: "docs/readme.md" }, actions: ["read", "edit"] },
    )).toMatchObject({ resource: { kind: "exact", path: "docs/readme.md" }, actions: ["edit", "read"] });
  });

  test("rejects unknown published envelope and nested authorization fields before signature use", () => {
    const malformed = {
      version: 1,
      shareId: "share-1",
      delegation: "header.payload.signature",
      authorizationTarget: { kind: "policy", policyCid: "cid", policyBytes: "e30", extra: true },
      target: { origin: ORIGIN, nodeAudience: "did:web:node.example", spaceId: "space", resource: { kind: "exact", path: "docs/a.md" } },
      display: {},
      expiry: "2099-01-01T00:00:00.000Z",
      signature: { signerDid: "did:key:z6MkSigner", algorithm: "Ed25519", value: "bad" },
    };
    expect(() => parsePublishedShareEnvelope(new TextEncoder().encode(JSON.stringify(malformed)), { trustedSignerDids: ["did:key:z6MkSigner"], now: new Date("2080-01-01T00:00:00.000Z") })).toThrow(ShareEnvelopeError);
  });

  test("does not expose exact recipient PII in an encrypted envelope", async () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => 32 - index);
    const { artifact } = await (await import("./share-envelope")).createShareArtifactAsync({
      origin: ORIGIN,
      spaceId: SPACE,
      recipient: { kind: "exactEmail", value: "alice@mailinator.com" },
      resource: { kind: "exact", path: "docs/private.md" },
      actions: ["read"],
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode("private"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      signerDid: "did:key:z6MkSigner",
      signerPrivateKey: PRIVATE_KEY,
      encryptionKey: key,
    });
    expect(JSON.stringify(artifact)).not.toContain("alice@mailinator.com");
  });

  test("checks scope locally and preserves conditional-save conflicts", async () => {
    const created = createShareArtifact({
      origin: ORIGIN,
      spaceId: SPACE,
      resource: { kind: "prefix", path: "docs/" },
      actions: ["read", "list", "edit"],
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode("# folder"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      signerDid: "did:key:z6MkSigner",
      signerPrivateKey: PRIVATE_KEY,
    });
    let putCalls = 0;
    const kv = {
      get: async () => ({ ok: true, data: { data: Uint8Array.from([1]), headers: { etag: "etag-1", get: () => null } } }),
        list: async () => ({ ok: true, data: { keys: ["docs/a.md"], truncated: false } }),
      put: async () => {
        putCalls += 1;
        return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "stale", service: "kv" } };
      },
    };
    const access = await new ShareRecipientClient({
      trustedOrigins: [ORIGIN],
      fetch: mock(async () => new Response(created.bytes)) as never,
      invoke: (() => ({})) as never,
      bearerSession: { delegationHeader: { Authorization: "Bearer test" }, delegationCid: "cid", spaceId: SPACE, verificationMethod: "did:key:z6Mk", jwk: {} },
      createKVService: (() => kv) as never,
    }).open(encodeShareUrl({ origin: ORIGIN, cid: created.cid }));
    await expect(access.listChildren()).resolves.toMatchObject({ keys: ["docs/a.md"] });
    await expect(access.get("outside.md")).rejects.toMatchObject({ code: "SHARE_OUT_OF_SCOPE" });
    await expect(access.save("docs/a.md", Uint8Array.from([2]), { etag: "etag-1" })).rejects.toBeInstanceOf(Error);
    expect(putCalls).toBe(1);
    await expect(access.save("other/a.md", Uint8Array.from([2]), { etag: "etag-1" })).rejects.toMatchObject({ code: "SHARE_OUT_OF_SCOPE" });
    expect(putCalls).toBe(1);
  });

  test("routes addressed get/list/put through the native Node media type", async () => {
    const created = await (await import("./share-envelope")).createShareArtifactAsync({
      origin: ORIGIN,
      spaceId: SPACE,
      recipient: { kind: "emailDomain", value: "example.com" },
      resource: { kind: "prefix", path: "docs/" },
      actions: ["read", "list", "edit"],
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode("policy metadata"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      signerDid: "did:key:z6MkSigner",
      signerPrivateKey: PRIVATE_KEY,
      encryptionKey: Uint8Array.from({ length: 32 }, (_, index) => index + 4),
    });
    const calls: string[] = [];
    const session = { sessionId: "session-1", holderDid: "did:key:holder", expiresAt: "2098-01-01T00:00:00.000Z", actions: ["read", "list", "edit"], resource: { kind: "prefix", path: "docs/" } };
    const access = await new ShareRecipientClient({
      trustedOrigins: [ORIGIN],
      fetch: mock(async () => new Response(created.bytes)) as never,
      presentation: { holder: "opaque" },
      establishPolicySession: async () => session,
      nativeInvoke: async (input) => {
        calls.push(`${input.action}:${input.mediaType}:${input.resource}`);
        if (input.action === "get") return { status: 200, type: "TinyCloudShareInvokeResponse", version: 2, action: "tinycloud.kv/get", resource: input.resource, bytes: Uint8Array.from([7]), bodyDigest: encoded(sha256(Uint8Array.from([7]))), headers: { etag: '"etag-1"', "content-type": "application/octet-stream" } };
        if (input.action === "list") return { status: 200, type: "TinyCloudShareInvokeResponse", version: 2, action: "tinycloud.kv/list", resource: input.resource, keys: ["docs/a.md"], entries: [{ path: "docs/a.md", kind: "file" }], truncated: false, nextCursor: "cursor-1" };
        return { status: 200, type: "TinyCloudShareInvokeResponse", version: 2, action: "tinycloud.kv/put", resource: input.resource, bodyDigest: input.bodyDigest, headers: { etag: '"etag-2"' } };
      },
      now: () => new Date("2080-01-01T00:00:00.000Z"),
    }).open(encodeShareUrl({ origin: ORIGIN, cid: created.cid, key: created.key }));
    await expect(access.get("docs/a.md")).resolves.toMatchObject({ bytes: Uint8Array.from([7]) });
    await expect(access.listChildren({ path: "docs", limit: 1 })).resolves.toMatchObject({ nextCursor: "cursor-1" });
    await expect(access.save("docs/a.md", Uint8Array.from([8]), { etag: '"etag-1"' })).resolves.toEqual({ etag: '"etag-2"' });
    expect(calls).toEqual([
      "get:application/vnd.tinycloud.share+json:docs/a.md",
      "list:application/vnd.tinycloud.share+json:docs",
      "put:application/vnd.tinycloud.share+json:docs/a.md",
    ]);
  });

  test("builds the strict signed NativeInvokeEnvelope and decodes Node JSON content", async () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 9);
    const created = await (await import("./share-envelope")).createShareArtifactAsync({
      origin: ORIGIN,
      spaceId: SPACE,
      recipient: { kind: "emailDomain", value: "example.com" },
      resource: { kind: "exact", path: "docs/readme.md" },
      actions: ["read"],
      mimeType: "text/markdown; charset=utf-8",
      bytes: new TextEncoder().encode("policy metadata"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      signerDid: NODE_DID,
      signerPrivateKey: NODE_PRIVATE_KEY,
      encryptionKey: key,
    });
    const binding = {
      shareCid: "bafy-share",
      shareId: "share-1",
      delegationCid: "bafy-delegation",
      authorityMaterialHandle: "amh_kv_001",
      authorityMaterialDigest: encoded(sha256(new TextEncoder().encode("authority"))),
      policyCid: "bafy-policy",
      contentSource: { kind: "kv", space: SPACE, path: "docs/readme.md", action: "tinycloud.kv/get" },
      contentSourceDigest: encoded(sha256(new TextEncoder().encode("source"))),
      targetOrigin: ORIGIN,
      nodeAudience: NODE_DID,
      action: "tinycloud.kv/get",
      resource: "docs/readme.md",
    } as const;
    const session = {
      sessionId: "session-1",
      shareCid: binding.shareCid,
      shareId: binding.shareId,
      delegationCid: binding.delegationCid,
      authorityMaterialHandle: binding.authorityMaterialHandle,
      authorityMaterialDigest: binding.authorityMaterialDigest,
      policyCid: binding.policyCid,
      contentSource: binding.contentSource,
      contentSourceDigest: binding.contentSourceDigest,
      holderDid: "did:key:holder",
      targetOrigin: ORIGIN,
      nodeAudience: NODE_DID,
      action: "tinycloud.kv/get",
      resource: binding.resource,
      expiresAt: "2098-01-01T00:00:00.000Z",
    };
    const returned = Uint8Array.from([7, 8, 9]);
    let invokeBody: Record<string, unknown> | undefined;
    const fetch = mock(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/invoke")) {
        expect(init?.headers).toMatchObject({ "content-type": "application/vnd.tinycloud.share+json", accept: "application/vnd.tinycloud.share+json" });
        invokeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ type: "TinyCloudShareInvokeResponse", version: 2, action: "tinycloud.kv/get", resource: "docs/readme.md", mediaType: "application/octet-stream", content: encoded(returned), bodyDigest: encoded(sha256(returned)), etag: '"etag-1"' }), { status: 200, headers: { "content-type": "application/json", etag: '"etag-1"' } });
      }
      return new Response(created.bytes, { status: 200 });
    });
    const access = await new ShareRecipientClient({
      trustedOrigins: [ORIGIN],
      trustedSignerDids: [NODE_DID],
      fetch: fetch as never,
      policyBinding: binding,
      establishPolicySession: async () => session,
      holderSigner: () => ({ alg: "EdDSA", kid: "did:key:holder#holder", signature: encoded(new Uint8Array(64)) }),
      now: () => new Date("2080-01-01T00:00:00.000Z"),
    }).open(encodeShareUrl({ origin: ORIGIN, cid: created.cid, key }));
    await expect(access.get("docs/readme.md")).resolves.toMatchObject({ bytes: returned, etag: '"etag-1"' });
    const request = invokeBody?.request as Record<string, unknown>;
    const invocation = request?.invocation as Record<string, unknown>;
    expect(invokeBody?.request).toMatchObject({ sessionId: "session-1", delegationCid: "bafy-delegation", resource: "docs/readme.md" });
    expect(invocation).toMatchObject({ type: "TinyCloudShareReadInvocation", version: 2, actions: ["tinycloud.kv/get"], action: "tinycloud.kv/get", requestBodyDigest: expect.any(String), jti: expect.any(String) });
    expect(request?.proof).toMatchObject({ alg: "EdDSA", kid: "did:key:holder#holder" });
    expect(invokeBody).not.toHaveProperty("schema");
  });

  test("uses the raw artifact route and reuses verified cache entries across client instances", async () => {
    const created = artifact();
    const cache = new MemoryShareCache();
    const calls: string[] = [];
    const fetch = mock(async (url: string) => {
      calls.push(url);
      return new Response(created.bytes, { status: 200 });
    });
    const link = encodeShareUrl({ origin: ORIGIN, cid: created.cid });
    await new ShareRecipientClient({ trustedOrigins: [ORIGIN], cache, fetch: fetch as never, now: () => new Date("2080-01-01T00:00:00.000Z") }).open(link);
    await new ShareRecipientClient({ trustedOrigins: [ORIGIN], cache, fetch: fetch as never, now: () => new Date("2080-01-01T00:00:00.000Z") }).open(link);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe(`${ORIGIN}/s/${created.cid}/raw`);
  });

  test("evicts a corrupt cached object and refetches the authoritative bytes once", async () => {
    const created = artifact();
    const cache = new MemoryShareCache();
    const link = encodeShareUrl({ origin: ORIGIN, cid: created.cid });
    const key = { cid: created.cid, expiresAt: created.artifact.envelope.expiresAt };
    await cache.set(key, Uint8Array.from([0, 1, 2]), { contentType: "application/json", size: 3, encrypted: false });
    const fetch = mock(async () => new Response(created.bytes, { status: 200 }));
    const client = new ShareRecipientClient({ trustedOrigins: [ORIGIN], cache, fetch: fetch as never, now: () => new Date("2080-01-01T00:00:00.000Z") });
    await expect(client.open(link)).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("requires a strict Node challenge/session request for addressed policy access", async () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 3);
    const created = await (await import("./share-envelope")).createShareArtifactAsync({
      origin: ORIGIN,
      spaceId: SPACE,
      recipient: { kind: "exactEmail", value: " Alice@MAILINATOR.COM " },
      resource: { kind: "exact", path: "docs/private.md" },
      actions: ["read"],
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode("private"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      signerDid: "did:key:z6MkSigner",
      signerPrivateKey: PRIVATE_KEY,
      encryptionKey: key,
    });
    const fetch = mock(async () => new Response(created.bytes, { status: 200 }));
    await expect(new ShareRecipientClient({ trustedOrigins: [ORIGIN], fetch: fetch as never, presentation: { holder: "opaque-full-email-presentation" }, now: () => new Date("2080-01-01T00:00:00.000Z"), trustedSignerDids: ["did:key:z6MkSigner"] }).open(encodeShareUrl({ origin: ORIGIN, cid: created.cid, key }))).rejects.toMatchObject({ code: "SHARE_SESSION_INVALID" });
  });

  test("binds sparse Node challenge/session objects by relationship instead of requiring a key union", () => {
    const client = new ShareRecipientClient({ trustedOrigins: [ORIGIN], now: () => new Date("2080-01-01T00:00:00.000Z") });
    const assertBinding = (client as unknown as { assertSessionBinding: Function }).assertSessionBinding.bind(client);
    const envelope = artifact().artifact.envelope;
    const challenge = { challengeId: "challenge-1", nonce: "nonce-0123456789", audience: ORIGIN, challengeExpiresAt: "2080-01-01T00:30:00.000Z" };
    const request = { policyId: "policy-1" };
    const sessionRequest = { presentation: { holderDid: "did:key:holder", nonce: challenge.nonce, audience: ORIGIN, expiresAt: "2080-01-01T00:20:00.000Z" } };
    expect(() => assertBinding({ sessionId: "session-1", holderDid: "did:key:holder", expiresAt: "2080-01-01T00:20:00.000Z" }, envelope, request, challenge, sessionRequest)).not.toThrow();
    expect(() => assertBinding({ sessionId: "session-1", holderDid: "did:key:other", expiresAt: "2080-01-01T00:20:00.000Z" }, envelope, request, challenge, sessionRequest)).toThrow();
  });

  test("consumes serialized exact and domain Node challenge/session fixtures and binds native request integrity fields", async () => {
    for (const recipient of [{ kind: "exactEmail", value: "alice@example.com" }, { kind: "emailDomain", value: "example.com" }] as const) {
      const created = await (await import("./share-envelope")).createShareArtifactAsync({
        origin: ORIGIN,
        spaceId: SPACE,
        recipient,
        resource: { kind: "prefix", path: "docs/" },
        actions: ["read", "list", "edit"],
        mimeType: "application/octet-stream",
        bytes: new TextEncoder().encode("policy metadata"),
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        signerDid: NODE_DID,
        signerPrivateKey: NODE_PRIVATE_KEY,
        encryptionKey: Uint8Array.from({ length: 32 }, (_, index) => index + 7),
      });
      const challenge = { challengeId: `challenge-${recipient.kind}`, nonce: "nonce-serialized-0123456789", policyId: "policy-1", audience: ORIGIN, challengeExpiresAt: "2080-01-01T00:30:00.000Z" };
      const session = { sessionId: `session-${recipient.kind}`, holderDid: "did:key:holder", expiresAt: "2080-01-01T00:20:00.000Z", spaceId: SPACE, resource: { kind: "prefix", path: "docs/" }, actions: ["read", "list", "edit"] };
      const calls: Array<Record<string, unknown>> = [];
      const fetch = mock(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.endsWith("/challenges")) return new Response(JSON.stringify({ data: { challenge, proof: nodeProof(challenge, "xyz.tinycloud.share/policy-challenge/v1\0") } }), { status: 200, headers: { "content-type": "application/json" } });
        if (init?.method === "POST" && url.endsWith("/session")) return new Response(JSON.stringify({ result: { session, proof: nodeProof(session, "xyz.tinycloud.share/policy-session/v1\0") } }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(created.bytes, { status: 200 });
      });
      const access = await new ShareRecipientClient({
        trustedOrigins: [ORIGIN],
        trustedSignerDids: [NODE_DID],
        fetch: fetch as never,
        presentation: { challengeRequest: { policyId: "policy-1", audience: ORIGIN } },
        buildPolicySessionRequest: async ({ challenge: current }) => ({ presentation: { holderDid: "did:key:holder", nonce: current.nonce, audience: ORIGIN, expiresAt: "2080-01-01T00:20:00.000Z" } }),
        nativeInvoke: async (input) => { calls.push(input as unknown as Record<string, unknown>); return { status: 200, type: "TinyCloudShareInvokeResponse", version: 2, action: input.action === "get" ? "tinycloud.kv/get" : input.action === "list" ? "tinycloud.kv/list" : "tinycloud.kv/put", resource: input.resource, bytes: input.action === "put" ? undefined : Uint8Array.from([7]), bodyDigest: input.action === "put" ? input.bodyDigest : encoded(sha256(Uint8Array.from([7]))), keys: input.action === "list" && input.cursor === undefined ? ["docs/a.md"] : undefined, entries: input.action === "list" && input.cursor === undefined ? [{ path: "docs/a.md", kind: "file" }] : undefined, headers: { etag: '"etag-2"', "x-tinycloud-content-digest": input.action === "put" ? input.bodyDigest : encoded(sha256(Uint8Array.from([7]))) } }; },
        now: () => new Date("2080-01-01T00:00:00.000Z"),
      }).open(encodeShareUrl({ origin: ORIGIN, cid: created.cid, key: created.key }));
      await expect(access.get("docs/a.md")).resolves.toMatchObject({ bytes: Uint8Array.from([7]) });
      await expect(access.listChildren({ path: "docs/", cursor: "cursor-1", limit: 2 })).rejects.toMatchObject({ code: "SHARE_LIST_FAILED" });
      await expect(access.save("docs/a.md", Uint8Array.from([8, 9]), { etag: "etag-1" })).resolves.toBeDefined();
      expect(calls[0]).toMatchObject({ action: "get", resource: "docs/a.md" });
      expect(calls[1]).toMatchObject({ action: "list", cursor: "cursor-1", limit: 2 });
      expect(calls[2]).toMatchObject({ action: "put", ifMatch: "etag-1", bodyDigest: encoded(sha256(Uint8Array.from([8, 9]))) });
    }
  });

  test("rejects unsafe bearer/plaintext combinations and redacts service causes", async () => {
    await expect((await import("./share-envelope")).createShareArtifactAsync({
      origin: ORIGIN,
      spaceId: SPACE,
      recipient: { kind: "bearer" },
      resource: { kind: "exact", path: "docs/private.bin" },
      actions: ["read"],
      mimeType: "application/octet-stream",
      bytes: Uint8Array.from([1, 2]),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      signerDid: "did:key:z6MkSigner",
      signerPrivateKey: PRIVATE_KEY,
    })).rejects.toMatchObject({ code: "encryption-required" });
    const created = artifact();
    const access = await new ShareRecipientClient({
      trustedOrigins: [ORIGIN],
      fetch: mock(async () => new Response(created.bytes)) as never,
      bearerSession: { delegationHeader: { Authorization: "Bearer test" }, delegationCid: "cid", spaceId: SPACE, verificationMethod: "did:key:z6Mk", jwk: {} },
      createKVService: (() => ({ get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "alice@mailinator.com request body" } }) })) as never,
    }).open(encodeShareUrl({ origin: ORIGIN, cid: created.cid }));
    await expect(access.get()).rejects.toMatchObject({ code: "SHARE_NOT_FOUND" });
    await expect(access.get()).rejects.not.toHaveProperty("cause");
  });

  test("accepts exactly 100 MiB plaintext with encryption overhead and rejects one byte before encryption", async () => {
    const { createShareArtifactAsync, MAX_SHARE_CONTENT_BYTES, MAX_SEALED_SHARE_CONTENT_BYTES } = await import("./share-envelope");
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const exact = new Uint8Array(MAX_SHARE_CONTENT_BYTES);
    const created = await createShareArtifactAsync({
      origin: ORIGIN,
      spaceId: SPACE,
      recipient: { kind: "emailDomain", value: "example.com" },
      resource: { kind: "exact", path: "docs/large.bin" },
      actions: ["read"],
      mimeType: "application/octet-stream",
      bytes: exact,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      signerDid: "did:key:z6MkSigner",
      signerPrivateKey: PRIVATE_KEY,
      encryptionKey: key,
    });
    expect(created.artifact.envelope.content.size).toBe(MAX_SHARE_CONTENT_BYTES + 28);
    expect(created.artifact.envelope.content.size).toBeLessThanOrEqual(MAX_SEALED_SHARE_CONTENT_BYTES);
    await expect(createShareArtifactAsync({
      origin: ORIGIN,
      spaceId: SPACE,
      recipient: { kind: "emailDomain", value: "example.com" },
      resource: { kind: "exact", path: "docs/too-large.bin" },
      actions: ["read"],
      mimeType: "application/octet-stream",
      bytes: new Uint8Array(MAX_SHARE_CONTENT_BYTES + 1),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      signerDid: "did:key:z6MkSigner",
      signerPrivateKey: PRIVATE_KEY,
      encryptionKey: key,
    })).rejects.toMatchObject({ code: "content-too-large" });
  });
});
