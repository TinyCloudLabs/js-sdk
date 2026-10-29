import { describe, expect, it } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize, didKeyFromEd25519PublicKey, signCompactUcanAuthorization, verifyCompactUcanAuthorization, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { ShareRecipientClient } from "../src/recipient.js";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalize(value));
const canonicalHash = (value: unknown): string => hex(sha256(encode(value)));

async function aesEncrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, ...(aad === undefined ? {} : { additionalData: aad as BufferSource }) }, cryptoKey, plaintext as BufferSource));
  return Uint8Array.from([...nonce, ...encrypted]);
}

async function recipientFixture(version: 1 | 2, aad?: Uint8Array) {
  const recipientKey = new Uint8Array(32).fill(9);
  const nodeKey = new Uint8Array(32).fill(8);
  const recipientDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(recipientKey));
  const nodeDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(nodeKey));
  const networkId = "urn:tinycloud:encryption:did:key:zOwner:default";
  const keyPath = version === 2 ? "share/recipient-v2" : undefined;
  const wrappedBytes = new Uint8Array(93).fill(17);
  const encryptedSymmetricKey = base64(wrappedBytes);
  const encryptedSymmetricKeyHash = canonicalHash(encryptedSymmetricKey);
  const registeredDigest = hex(sha256(wrappedBytes));
  const now = Math.floor(Date.now() / 1000);
  const resource = keyPath === undefined ? networkId : `${networkId}/${keyPath}`;
  const session = await signCompactUcanAuthorization({ issuerDid: nodeDid, audienceDid: recipientDid, attenuation: { [resource]: { "tinycloud.encryption/decrypt": [{}] } }, facts: [{ profile: "policy-session-ucan/v1", policyCid: "policy", recipientDid }], proofs: ["policy-root", "enforcement-root"], notBefore: now - 1, expiresAt: now + 59, nonce: "session", sign: async (bytes) => ed25519.sign(bytes, nodeKey) });
  const symmetricKey = new Uint8Array(32).fill(41);
  const ciphertext = await aesEncrypt(symmetricKey, new TextEncoder().encode("hello"), aad);
  const content: Record<string, unknown> = { v: version, networkId, ...(keyPath === undefined ? {} : { keyPath }), alg: "x25519-aes256gcm/v1", keyVersion: 3, encryptedSymmetricKey, encryptedSymmetricKeyHash, ciphertext: base64(ciphertext), ...(aad === undefined ? {} : { aad: base64(aad) }), metadata: { contentType: "text/plain", label: "synthetic" } };
  const stored = encode(content);
  let decryptInvocations = 0;
  const fetchFn: typeof fetch = async (_input, init) => {
    decryptInvocations += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const receiverPublicKey = Uint8Array.from(Buffer.from(String(body.receiverPublicKey), "base64"));
    const ephemeralPrivate = new Uint8Array(32).fill(23);
    const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
    const shared = x25519.getSharedSecret(ephemeralPrivate, receiverPublicKey);
    const wrapped = await aesEncrypt(shared, symmetricKey);
    const invocation = verifyCompactUcanAuthorization(new Headers(init?.headers).get("Authorization")!);
    expect(invocation.payload.att).toEqual({ [resource]: { "tinycloud.encryption/decrypt": [{}] } });
    expect(body).toMatchObject({ networkId, keyVersion: 3, encryptedSymmetricKeyHash });
    if (keyPath === undefined) expect(body).not.toHaveProperty("keyPath");
    else expect(body.keyPath).toBe(keyPath);
    const bodyHash = canonicalHash(body);
    const unsigned = { type: "tinycloud.encryption.decrypt-result/v1", targetNode: nodeDid, networkId, invocationCid: invocation.cid, encryptedSymmetricKeyHash, receiverPublicKeyHash: body.receiverPublicKeyHash, wrappedKey: base64(Uint8Array.from([...ephemeralPublic, 1, ...wrapped])), alg: "x25519-aes256gcm/v1", keyVersion: 3, requestHash: hex(sha256(new TextEncoder().encode(`${invocation.cid}${bodyHash}`))), nodeId: nodeDid };
    return Response.json({ ...unsigned, nodeSignature: base64(ed25519.sign(encode(unsigned), nodeKey)) });
  };
  const envelope = {
    version: 3,
    shareId: "recipient-v2",
    target: { nodeAudience: nodeDid, spaceId: "space" },
    actions: ["read"],
    resource: { kind: "exact", path: "shares/file.txt" },
    policy: { capabilityCeiling: [] },
    encryptionNetwork: networkId,
    contentSource: {
      kvResource: "space/kv/shares/file.txt",
      encryptionNetwork: networkId,
      ...(keyPath === undefined ? {} : { encryptionKeyPath: keyPath }),
      keyVersion: 3,
      encryptedSymmetricKeyDigestHex: registeredDigest,
      initialCiphertextDigestHex: hex(sha256(stored)),
    },
    metadata: { mediaType: "text/plain" },
  };
  // This in-process decrypt fixture omits admission-only envelope fields.
  const recipientEnvelope = envelope as unknown as ShareEnvelopeV3;
  const client = new ShareRecipientClient({ nodeOrigin: "http://127.0.0.1:1", envelope: recipientEnvelope, holderDid: recipientDid, fetchFn });
  Object.assign(client, { session: { sessionId: session.cid }, v3Authorization: session.authorization, v3NodeAudience: nodeDid, nativeSigner: async (bytes: Uint8Array) => ed25519.sign(bytes, recipientKey) });
  return { client, envelope, content, stored, symmetricKey, encryptedSymmetricKeyHash, registeredDigest, decryptInvocations: () => decryptInvocations };
}

describe("v3 recipient content", () => {
  it("preserves v1 root-only behavior with independent canonical and raw digests", async () => {
    const fixture = await recipientFixture(1);
    const opened = await fixture.client.decryptV3Content(fixture.stored);
    expect(new TextDecoder().decode(opened.bytes)).toBe("hello");
    expect(opened.mediaType).toBe("text/plain");
    expect(fixture.decryptInvocations()).toBe(1);
  });

  for (const aad of [undefined, new Uint8Array(), new TextEncoder().encode("share recipient AAD")]) {
    it(`opens v2 named-key content with ${aad === undefined ? "no" : aad.length === 0 ? "empty" : "nonempty"} AAD and distinct digests`, async () => {
      const fixture = await recipientFixture(2, aad);
      const opened = await fixture.client.decryptV3Content(fixture.stored);
      expect(new TextDecoder().decode(opened.bytes)).toBe("hello");
      expect(opened.mediaType).toBe("text/plain");
      expect(fixture.decryptInvocations()).toBe(1);
    });
  }

  it("opens standard-base64 binary AAD containing both non-URL alphabet characters", async () => {
    const fixture = await recipientFixture(2, new Uint8Array([251, 255]));
    const opened = await fixture.client.decryptV3Content(fixture.stored);
    expect(new TextDecoder().decode(opened.bytes)).toBe("hello");
    expect(fixture.decryptInvocations()).toBe(1);
  });

  for (const [version, aad] of [
    [1, undefined],
    [1, new TextEncoder().encode("share recipient AAD")],
    [2, undefined],
    [2, new Uint8Array()],
    [2, new TextEncoder().encode("share recipient AAD")],
  ] as const) {
    it(`reencrypts admitted v${version} content with ${aad === undefined ? "no" : aad.length === 0 ? "empty" : "nonempty"} AAD`, async () => {
      const fixture = await recipientFixture(version, aad);
      await fixture.client.decryptV3Content(fixture.stored);
      const edited = new TextEncoder().encode("edited");
      const saved = JSON.parse(new TextDecoder().decode(await fixture.client.encryptV3Content(edited, "text/markdown"))) as { ciphertext: string; aad?: string; metadata: { contentType: string } };
      const sealed = Uint8Array.from(Buffer.from(saved.ciphertext, "base64"));
      const cryptoKey = await crypto.subtle.importKey("raw", fixture.symmetricKey as BufferSource, "AES-GCM", false, ["decrypt"]);
      const opened = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12), ...(aad === undefined ? {} : { additionalData: aad as BufferSource }) }, cryptoKey, sealed.slice(12)));
      expect(opened).toEqual(edited);
      expect(saved.aad).toBe(fixture.content.aad);
      expect(saved.ciphertext).toBe(base64(sealed));
      expect(saved.metadata.contentType).toBe("text/markdown");
    });
  }

  for (const [label, ciphertext] of [
    ["invalid base64", "not base64!"],
    ["empty payload", ""],
    ["truncated AES-GCM payload", base64(new Uint8Array(27))],
    ["noncanonical two-pad trailing bits", base64(new Uint8Array(28)).replace(/AA==$/, "AB==")],
    ["noncanonical one-pad trailing bits", base64(new Uint8Array(29)).replace(/AAA=$/, "AAB=")],
    ["base64url alphabet", base64(new Uint8Array(28).fill(255)).replace(/\//g, "_")],
    ["missing standard padding", base64(new Uint8Array(28)).replace(/=+$/, "")],
  ]) {
    it(`rejects malformed ciphertext (${label}) before decrypting the key`, async () => {
      const fixture = await recipientFixture(2);
      fixture.content.ciphertext = ciphertext;
      const stored = encode(fixture.content);
      fixture.envelope.contentSource.initialCiphertextDigestHex = hex(sha256(stored));
      await expect(fixture.client.decryptV3Content(stored)).rejects.toThrow();
      expect(fixture.decryptInvocations()).toBe(0);
    });
  }

  it("requires exact signed owner-KV bytes before any decrypt request", async () => {
    const fixture = await recipientFixture(2);
    const substituted = Uint8Array.from([0x20, ...fixture.stored]);
    await expect(fixture.client.decryptV3Content(substituted)).rejects.toThrow();
    expect(fixture.decryptInvocations()).toBe(0);
  });

  const mutations: ReadonlyArray<readonly [string, (content: Record<string, unknown>, source: Record<string, unknown>) => void]> = [
    ["canonical hash", (content) => { content.encryptedSymmetricKeyHash = "0".repeat(64); }],
    ["registered raw digest", (_content, source) => { source.encryptedSymmetricKeyDigestHex = "0".repeat(64); }],
    ["canonical hash substituted for raw digest", (content, source) => { source.encryptedSymmetricKeyDigestHex = content.encryptedSymmetricKeyHash; }],
    ["raw digest substituted for canonical hash", (content, source) => { content.encryptedSymmetricKeyHash = source.encryptedSymmetricKeyDigestHex; }],
    ["wrapped key with recomputed canonical hash", (content) => { content.encryptedSymmetricKey = base64(new Uint8Array(93).fill(18)); content.encryptedSymmetricKeyHash = canonicalHash(content.encryptedSymmetricKey); }],
    ["network", (content) => { content.networkId = "urn:tinycloud:encryption:did:key:zOther:default"; }],
    ["registered network", (_content, source) => { source.encryptionNetwork = "urn:tinycloud:encryption:did:key:zOther:default"; }],
    ["sibling key path", (content) => { content.keyPath = "share/other"; }],
    ["descendant key path", (content) => { content.keyPath = "share/recipient-v2/child"; }],
    ["key version", (content) => { content.keyVersion = 4; }],
    ["named-key source downgraded to root", (content) => { content.v = 1; delete content.keyPath; }],
    ["v1 falsely carrying a named-key path", (content) => { content.v = 1; }],
    ["malformed AAD", (content) => { content.aad = "not base64!"; }],
    ["non-string metadata", (content) => { content.metadata = { label: 3 }; }],
  ];
  for (const [label, mutate] of mutations) {
    it(`refuses ${label} before any decrypt request`, async () => {
      const fixture = await recipientFixture(2);
      mutate(fixture.content, fixture.envelope.contentSource);
      const substituted = encode(fixture.content);
      // Bind the substituted representation to isolate the inner-envelope
      // guard; owner-KV byte substitution is independently tested above.
      fixture.envelope.contentSource.initialCiphertextDigestHex = hex(sha256(substituted));
      await expect(fixture.client.decryptV3Content(substituted)).rejects.toThrow();
      expect(fixture.decryptInvocations()).toBe(0);
    });
  }

  it("refuses ciphertext tampering before any decrypt request", async () => {
    const fixture = await recipientFixture(2);
    fixture.content.ciphertext = base64(new Uint8Array(32).fill(2));
    await expect(fixture.client.decryptV3Content(encode(fixture.content))).rejects.toThrow();
    expect(fixture.decryptInvocations()).toBe(0);
  });

  it("never treats v2 named-key content as an unscoped root source", async () => {
    const fixture = await recipientFixture(2);
    delete fixture.envelope.contentSource.encryptionKeyPath;
    await expect(fixture.client.decryptV3Content(fixture.stored)).rejects.toThrow();
    expect(fixture.decryptInvocations()).toBe(0);
  });
});
