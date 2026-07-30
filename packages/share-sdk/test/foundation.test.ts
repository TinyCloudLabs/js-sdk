import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { bearerResourceUri, canonicalize, computeCid, didKeyFromEd25519PublicKey, encodeInlineShareUrl, encodeShareUrl, fromBase64Url, generateKey, mintBearerDelegation, open, parseInlineShareUrl, seal, signEnvelope, signEnvelopeV2, toBase64Url } from "@tinycloud/share-envelope";
import { MemoryShareCache } from "../src/cache.js";
import { DEFAULT_MAX_SEALED_BLOB_BYTES, ShareReceiveError, inspectShare, receiveShare, toShareErrorInfo } from "../src/receive.js";

const origin = "https://share.tinycloud.xyz";
const issuerPrivateKey = new Uint8Array(32).fill(17);
const sessionPrivateKey = new Uint8Array(32).fill(19);
const expiry = "2030-01-01T00:00:00.000Z";

async function makeShare() {
  const sessionPublicKey = ed25519.getPublicKey(sessionPrivateKey);
  const sessionJwk = {
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    x: toBase64Url(sessionPublicKey),
    d: toBase64Url(sessionPrivateKey),
  };
  const delegation = mintBearerDelegation({
    issuerPrivateKey,
    audienceDid: didKeyFromEd25519PublicKey(sessionPublicKey),
    resourceUri: bearerResourceUri(origin, "space", "docs/readme.md"),
    expiresAtSeconds: Math.floor(Date.parse(expiry) / 1000),
  });
  const content = new TextEncoder().encode("hello from the headless SDK");
  const contentKey = generateKey();
  const sealedContent = await seal(content, contentKey);
  const envelope = signEnvelope({
    version: 1,
    shareId: "share-test",
    delegation,
    authorizationTarget: { kind: "bearerKey", sessionJwk },
    target: { origin, nodeAudience: "did:web:node.example", spaceId: "space", resource: { kind: "exact", path: "docs/readme.md" } },
    display: { filename: "readme.md" },
    expiry,
    content: { cid: sealedContent.cid, key: toBase64Url(contentKey) },
  }, issuerPrivateKey);
  const envelopeKey = generateKey();
  const sealedEnvelope = await seal(new TextEncoder().encode(canonicalize(envelope)), envelopeKey);
  return { url: encodeShareUrl({ origin, ciphertextCid: sealedEnvelope.cid, key32: envelopeKey }), sealedEnvelope, sealedContent };
}

async function makeAddressedShare() {
  const policy = { issuerDid: didKeyFromEd25519PublicKey(ed25519.getPublicKey(issuerPrivateKey)), recipientMatcher: { kind: "exactEmail", value: "person@example.com" }, version: 2 };
  const policyBytes = new TextEncoder().encode(canonicalize(policy));
  const digest = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", policyBytes)));
  const source = { kind: "kv" as const, space: "space", path: "docs/readme.md", action: "tinycloud.kv/get" as const };
  const envelope = signEnvelopeV2({
    version: 2,
    shareId: "addressed-test",
    recipientMatcher: policy.recipientMatcher,
    deliveryEmail: "person@example.com",
    actions: ["read"],
    resource: { kind: "exact", path: "docs/readme.md" },
    target: { origin, nodeAudience: "did:web:node.example", spaceId: "space" },
    delegationCid: "bafy-delegation",
    authorityMaterialHandle: "bafy-authority",
    authorityMaterialDigest: digest,
    contentSource: source,
    contentSourceDigest: digest,
    authorizationTarget: { kind: "policy", policyCid: await computeCid(policyBytes), policyBytes: toBase64Url(policyBytes) },
    display: { filename: "readme.md" },
    expiry,
    encrypted: true,
    metadata: { mediaType: "text/markdown", byteLength: 5, filename: "readme.md" },
  }, issuerPrivateKey);
  const envelopeKey = generateKey();
  const sealedEnvelope = await seal(new TextEncoder().encode(canonicalize(envelope)), envelopeKey);
  return {
    url: encodeShareUrl({ origin, ciphertextCid: sealedEnvelope.cid, key32: envelopeKey }),
    sealedEnvelope,
    policyEvidence: {
      policyCid: await computeCid(policyBytes),
      signerDid: didKeyFromEd25519PublicKey(ed25519.getPublicKey(issuerPrivateKey)),
      registrationCid: "bafy-registration",
      shareId: envelope.shareId,
      recipientMatcher: envelope.recipientMatcher,
      target: envelope.target,
      resource: envelope.resource,
      actions: envelope.actions,
      contentSource: envelope.contentSource,
      contentSourceDigest: envelope.contentSourceDigest,
      delegationCid: envelope.delegationCid,
      authorityMaterialHandle: envelope.authorityMaterialHandle,
      authorityMaterialDigest: envelope.authorityMaterialDigest,
      expiresAt: envelope.expiry,
    },
  };
}

describe("@tinycloud/share-sdk foundation", () => {
  it("stores only verified-byte copies and expires entries", async () => {
    const cache = new MemoryShareCache(() => new Date("2026-01-01T00:00:00.000Z"));
    const key = { cid: "bafkrei-test", expiresAt: "2026-01-02T00:00:00.000Z" };
    const bytes = new Uint8Array([1, 2, 3]);
    await cache.set(key, bytes, { contentType: "text/plain", size: 3, encrypted: true });
    bytes[0] = 9;
    expect(await cache.get(key, new Date("2026-01-01T12:00:00.000Z"))).toEqual(new Uint8Array([1, 2, 3]));
    expect(await cache.get(key, new Date("2026-01-02T00:00:00.000Z"))).toBeUndefined();
  });

  it("uses redacted, stable receive error codes", () => {
    const error = new ShareReceiveError("invalid-link", "share link format is invalid");
    expect(error.code).toBe("invalid-link");
    expect(error.message).not.toContain("#k=");
    expect(JSON.stringify(error)).not.toContain("share link format");
    expect(toShareErrorInfo(new Error("fragment #k=secret"))).toEqual({
      protocol: "tinycloud-share",
      version: 1,
      error: { code: "fetch-failed" },
    });
  });

  it("inspects and receives a compact share through injected storage", async () => {
    const share = await makeShare();
    const blobs = new Map([[share.sealedEnvelope.cid, share.sealedEnvelope.blob], [share.sealedContent.cid, share.sealedContent.blob]]);
    const fetchBlob = async ({ cid }: { readonly cid: string }) => blobs.get(cid)!;
    const inspection = await inspectShare(share.url, { fetchBlob, now: () => Date.parse("2029-01-01T00:00:00.000Z") });
    expect(inspection.metadata.shareId).toBe("share-test");
    expect(inspection.metadata).not.toHaveProperty("authorizationTarget");
    expect(JSON.stringify(inspection)).not.toContain("sessionJwk");
    expect(JSON.stringify(inspection)).not.toContain("delegation");
    expect(JSON.stringify(inspection)).not.toContain("content.key");
    const received = await receiveShare(share.url, { fetchBlob, now: () => Date.parse("2029-01-01T00:00:00.000Z") });
    expect(received.text).toBe("hello from the headless SDK");
  });

  it("applies maxContentBlobBytes after decrypting sealed content", async () => {
    const share = await makeShare();
    const blobs = new Map([[share.sealedEnvelope.cid, share.sealedEnvelope.blob], [share.sealedContent.cid, share.sealedContent.blob]]);
    const fetchBlob = async ({ cid }: { readonly cid: string }) => blobs.get(cid)!;
    const contentBytes = new TextEncoder().encode("hello from the headless SDK");
    await expect(receiveShare(share.url, {
      fetchBlob,
      maxContentBlobBytes: contentBytes.byteLength,
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    })).resolves.toMatchObject({ text: "hello from the headless SDK" });
    await expect(receiveShare(share.url, {
      fetchBlob,
      maxContentBlobBytes: contentBytes.byteLength - 1,
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "max-bytes-exceeded" });
  });


  it("rejects an oversized fetched envelope before decryption", async () => {
    const share = await makeShare();
    await expect(inspectShare(share.url, { fetchBlob: async () => new Uint8Array(DEFAULT_MAX_SEALED_BLOB_BYTES + 1) })).rejects.toMatchObject({ code: "max-bytes-exceeded" });
  });

  it("normalizes transport failures to the redacted fetch error", async () => {
    const share = await makeShare();
    await expect(inspectShare(share.url, { fetchBlob: async () => { throw new Error("network token #k=secret"); } })).rejects.toMatchObject({ code: "fetch-failed" });
    await expect(inspectShare(share.url, {
      registryBaseUrl: "https://registry.example",
      fetchFn: async () => { throw new Error("network token #k=secret"); },
    })).rejects.toMatchObject({ code: "fetch-failed" });
  });

  it("rejects a CID mismatch before decryption", async () => {
    const share = await makeShare();
    const tampered = new Uint8Array(share.sealedEnvelope.blob);
    tampered[tampered.length - 1] ^= 1;
    await expect(inspectShare(share.url, { fetchBlob: async () => tampered })).rejects.toMatchObject({ code: "cid-mismatch" });
    expect(await computeCid(tampered)).not.toBe(share.sealedEnvelope.cid);
  });

  it("rejects a signed envelope whose link origin is not the trusted target origin", async () => {
    const share = await makeShare();
    await expect(inspectShare(share.url.replace(origin, "https://other.example"), {
      fetchBlob: async () => share.sealedEnvelope.blob,
      expectedOrigin: "https://other.example",
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "origin-mismatch" });
  });

  it("binds the signed origin even when no caller allowlist is supplied", async () => {
    const share = await makeShare();
    const moved = share.url.replace(origin, "https://copied.example");
    await expect(inspectShare(moved, {
      fetchBlob: async () => share.sealedEnvelope.blob,
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "origin-mismatch" });
  });

  it("stops a streaming registry response at the configured byte limit", async () => {
    const share = await makeShare();
    const oversized = new Uint8Array(DEFAULT_MAX_SEALED_BLOB_BYTES + 1);
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/octet-stream" } });
    await expect(inspectShare(share.url, {
      registryBaseUrl: "https://registry.example",
      fetchFn: async () => response,
    })).rejects.toMatchObject({ code: "max-bytes-exceeded" });
  });

  it("rejects prefix resources before any content fetch", async () => {
    const share = await makeShare();
    const envelopeText = new TextDecoder().decode(await (async () => {
      const key = fromBase64Url(share.url.slice(share.url.indexOf("#k=") + 3));
      try { return await open(share.sealedEnvelope.blob, key); }
      finally { key.fill(0); }
    })());
    const parsedEnvelope = JSON.parse(envelopeText) as Record<string, unknown>;
    const { signature: _signature, ...envelope } = parsedEnvelope;
    (envelope.target as Record<string, unknown>).resource = { kind: "prefix", path: "docs" };
    const resigned = signEnvelope(envelope as never, issuerPrivateKey);
    const envelopeKey = generateKey();
    const sealed = await seal(new TextEncoder().encode(canonicalize(resigned)), envelopeKey);
    const url = encodeShareUrl({ origin, ciphertextCid: sealed.cid, key32: envelopeKey });
    let fetches = 0;
    await expect(inspectShare(url, {
      fetchBlob: async ({ cid }) => {
        fetches += 1;
        return cid === sealed.cid ? sealed.blob : share.sealedContent.blob;
      },
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "unsupported-target" });
    expect(fetches).toBe(1);
    envelopeKey.fill(0);
  });

  it("accepts canonical inline payloads and rejects reordered JSON", async () => {
    const share = await makeShare();
    const inline = await encodeInlineShareUrl({ origin, ciphertext: share.sealedEnvelope.blob, key32: new Uint8Array(32).fill(5) });
    expect(parseInlineShareUrl(inline).ciphertext).toEqual(share.sealedEnvelope.blob);
    const payload = inline.slice(inline.indexOf("#v=2&p=") + "#v=2&p=".length);
    const decoded = new TextDecoder().decode(fromBase64Url(payload));
    const value = JSON.parse(decoded) as Record<string, unknown>;
    const reordered = JSON.stringify({ v: value.v, c: value.c, cid: value.cid, k: value.k });
    const reorderedUrl = `${origin}/s/inline#v=2&p=${toBase64Url(new TextEncoder().encode(reordered))}`;
    expect(() => parseInlineShareUrl(reorderedUrl)).toThrow(/canonical JSON/);
  });

  it("inspects and receives an inline share through the same verifier", async () => {
    const share = await makeShare();
    const envelopeKey = fromBase64Url(share.url.slice(share.url.indexOf("#k=") + 3));
    try {
      const inline = await encodeInlineShareUrl({ origin, ciphertext: share.sealedEnvelope.blob, key32: envelopeKey });
      const blobs = new Map([[share.sealedContent.cid, share.sealedContent.blob]]);
      const options = {
        fetchBlob: async ({ cid }: { readonly cid: string }) => blobs.get(cid)!,
        now: () => Date.parse("2029-01-01T00:00:00.000Z"),
      };
      expect((await inspectShare(inline, options)).link.kind).toBe("inline");
      expect((await receiveShare(inline, options)).text).toBe("hello from the headless SDK");
    } finally {
      envelopeKey.fill(0);
    }
  });

  it("verifies addressed v2 envelopes once and returns a typed authorization step", async () => {
    const share = await makeAddressedShare();
    const inspection = await inspectShare(share.url, {
      fetchBlob: async () => share.sealedEnvelope.blob,
      trustedSignerDid: didKeyFromEd25519PublicKey(ed25519.getPublicKey(issuerPrivateKey)),
      trustedPolicyAuthority: { resolve: async () => share.policyEvidence },
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    });
    expect(inspection.metadata.shareId).toBe("addressed-test");
    expect(JSON.stringify(inspection)).not.toContain("policyBytes");
    const pending = await receiveShare(share.url, {
      fetchBlob: async () => share.sealedEnvelope.blob,
      trustedSignerDid: didKeyFromEd25519PublicKey(ed25519.getPublicKey(issuerPrivateKey)),
      trustedPolicyAuthority: { resolve: async () => share.policyEvidence },
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    });
    expect(pending).toEqual({ state: "authorization-required", method: "email-claim" });
    const addressedBytes = new TextEncoder().encode("hello");
    const addressedBodyDigest = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", addressedBytes)));
    const received = await receiveShare(share.url, {
      fetchBlob: async () => share.sealedEnvelope.blob,
      trustedSignerDid: didKeyFromEd25519PublicKey(ed25519.getPublicKey(issuerPrivateKey)),
      trustedPolicyAuthority: { resolve: async () => share.policyEvidence },
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
      authorization: { async begin(input) { return { state: "ready", value: { bytes: addressedBytes, bodyDigest: addressedBodyDigest, contentSourceDigest: input.envelope.contentSourceDigest, binding: { shareId: input.envelope.shareId, delegationCid: input.envelope.delegationCid, authorityMaterialHandle: input.envelope.authorityMaterialHandle, authorityMaterialDigest: input.envelope.authorityMaterialDigest, resource: input.envelope.resource }, proof: "verified-by-fixture" } }; }, async resume() { return { state: "denied", reason: "unsupported" }; }, async verifyResult() { return true; } },
    });
    expect("state" in received ? received : received.text).toBe("hello");
  });

  it("does not treat envelope policy bytes as an addressed trust root", async () => {
    const share = await makeAddressedShare();
    const options = {
      fetchBlob: async () => share.sealedEnvelope.blob,
      trustedSignerDid: didKeyFromEd25519PublicKey(ed25519.getPublicKey(issuerPrivateKey)),
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    };
    await expect(inspectShare(share.url, options)).rejects.toMatchObject({ code: "envelope-invalid" });
    await expect(inspectShare(share.url, {
      ...options,
      trustedPolicyAuthority: { resolve: async () => ({ ...share.policyEvidence, signerDid: "did:key:z6Mkattacker" }) },
    })).rejects.toMatchObject({ code: "capability-invalid" });
  });

  it("rejects addressed envelopes after their signed expiry", async () => {
    const share = await makeAddressedShare();
    await expect(inspectShare(share.url, {
      fetchBlob: async () => share.sealedEnvelope.blob,
      trustedSignerDid: didKeyFromEd25519PublicKey(ed25519.getPublicKey(issuerPrivateKey)),
      trustedPolicyAuthority: { resolve: async () => share.policyEvidence },
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "expired" });
  });
});
