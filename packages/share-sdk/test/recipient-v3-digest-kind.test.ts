import { describe, expect, it } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize, didKeyFromEd25519PublicKey, signCompactUcanAuthorization, verifyCompactUcanAuthorization, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { ShareRecipientClient } from "../src/recipient.js";

// The V3 source registers the wrapped-key digest with a meaning that depends on the source kind: a path-bound source
// (`encryptionKeyPath`) registers the digest of the raw wrapped-key bytes; a legacy no-path source registers the canonical
// hash of the base64 string. The recipient must accept exactly the registered meaning for each kind.

const WRAPPED_KEY_BASE64 = "AQIDBA=="; // bytes 01020304
const RAW_DIGEST = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"; // sha256(01020304)
const CANONICAL_HASH = "07422ef82e3b2b231b2eb856c87bd6c7de3281e4d61dec155696b76aaf2af32f"; // sha256(canonicalize("AQIDBA=="))

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalize(value));

async function aesEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, plaintext as BufferSource));
  return Uint8Array.from([...nonce, ...encrypted]);
}

/** A recipient over one admitted V3 source; `registeredDigest` and `wrappedKeyBase64` are what the tests vary. */
async function fixture(options: { readonly pathBound: boolean; readonly registeredDigest: string; readonly wrappedKeyBase64?: string }) {
  const recipientKey = new Uint8Array(32).fill(9);
  const nodeKey = new Uint8Array(32).fill(8);
  const recipientDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(recipientKey));
  const nodeDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(nodeKey));
  const networkId = "urn:tinycloud:encryption:did:key:zOwner:default";
  const shareId = "digest-kind";
  const keyPath = options.pathBound ? `share/${shareId}` : undefined;
  const encryptedSymmetricKey = options.wrappedKeyBase64 ?? WRAPPED_KEY_BASE64;
  const encryptedSymmetricKeyHash = hex(sha256(encode(encryptedSymmetricKey)));
  const resource = keyPath === undefined ? networkId : `${networkId}/${keyPath}`;
  const now = Math.floor(Date.now() / 1000);
  const session = await signCompactUcanAuthorization({ issuerDid: nodeDid, audienceDid: recipientDid, attenuation: { [resource]: { "tinycloud.encryption/decrypt": [{}] } }, facts: [{ profile: "policy-session-ucan/v1", policyCid: "policy", recipientDid }], proofs: ["policy-root", "enforcement-root"], notBefore: now - 1, expiresAt: now + 59, nonce: "session", sign: async (bytes) => ed25519.sign(bytes, nodeKey) });
  const symmetricKey = new Uint8Array(32).fill(41);
  const content = { v: options.pathBound ? 2 : 1, networkId, ...(keyPath === undefined ? {} : { keyPath }), alg: "x25519-aes256gcm/v1", keyVersion: 3, encryptedSymmetricKey, encryptedSymmetricKeyHash, ciphertext: base64(await aesEncrypt(symmetricKey, new TextEncoder().encode("hello"))), metadata: { contentType: "text/plain" } };
  const stored = encode(content);
  let decryptInvocations = 0;
  const fetchFn: typeof fetch = async (_input, init) => {
    decryptInvocations += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const receiverPublicKey = Uint8Array.from(Buffer.from(String(body.receiverPublicKey), "base64"));
    const ephemeralPrivate = new Uint8Array(32).fill(23);
    const shared = x25519.getSharedSecret(ephemeralPrivate, receiverPublicKey);
    const wrapped = await aesEncrypt(shared, symmetricKey);
    const invocation = verifyCompactUcanAuthorization(new Headers(init?.headers).get("Authorization")!);
    // The invoke body carries the canonical envelope hash whatever the source kind registers.
    expect(body.encryptedSymmetricKeyHash).toBe(encryptedSymmetricKeyHash);
    const bodyHash = hex(sha256(encode(body)));
    const unsigned = { type: "tinycloud.encryption.decrypt-result/v1", targetNode: nodeDid, networkId, invocationCid: invocation.cid, encryptedSymmetricKeyHash, receiverPublicKeyHash: body.receiverPublicKeyHash, wrappedKey: base64(Uint8Array.from([...x25519.getPublicKey(ephemeralPrivate), 1, ...wrapped])), alg: "x25519-aes256gcm/v1", keyVersion: 3, requestHash: hex(sha256(new TextEncoder().encode(`${invocation.cid}${bodyHash}`))), nodeId: nodeDid };
    return Response.json({ ...unsigned, nodeSignature: base64(ed25519.sign(encode(unsigned), nodeKey)) });
  };
  const envelope = {
    version: 3,
    shareId,
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
      encryptedSymmetricKeyDigestHex: options.registeredDigest,
      initialCiphertextDigestHex: hex(sha256(stored)),
    },
    metadata: { mediaType: "text/plain" },
  };
  const client = new ShareRecipientClient({ nodeOrigin: "http://127.0.0.1:1", envelope: envelope as unknown as ShareEnvelopeV3, holderDid: recipientDid, fetchFn });
  Object.assign(client, { session: { sessionId: session.cid }, v3Authorization: session.authorization, v3NodeAudience: nodeDid, nativeSigner: async (bytes: Uint8Array) => ed25519.sign(bytes, recipientKey) });
  return { client, stored, decryptInvocations: () => decryptInvocations };
}

describe("v3 recipient wrapped-key digest by source kind", () => {
  it("opens a legacy no-path source that registered the canonical hash", async () => {
    const f = await fixture({ pathBound: false, registeredDigest: CANONICAL_HASH });
    const opened = await f.client.decryptV3Content(f.stored);
    expect(new TextDecoder().decode(opened.bytes)).toBe("hello");
    expect(f.decryptInvocations()).toBe(1);
  });

  it("opens a path-bound source that registered the raw digest", async () => {
    const f = await fixture({ pathBound: true, registeredDigest: RAW_DIGEST });
    const opened = await f.client.decryptV3Content(f.stored);
    expect(new TextDecoder().decode(opened.bytes)).toBe("hello");
    expect(f.decryptInvocations()).toBe(1);
  });

  it("refuses a path-bound source that registered the canonical hash", async () => {
    const f = await fixture({ pathBound: true, registeredDigest: CANONICAL_HASH });
    await expect(f.client.decryptV3Content(f.stored)).rejects.toThrow("encrypted content envelope binding is invalid");
    expect(f.decryptInvocations()).toBe(0);
  });

  it("refuses a legacy no-path source that registered the raw digest", async () => {
    const f = await fixture({ pathBound: false, registeredDigest: RAW_DIGEST });
    await expect(f.client.decryptV3Content(f.stored)).rejects.toThrow("encrypted content envelope binding is invalid");
    expect(f.decryptInvocations()).toBe(0);
  });

  for (const [kind, pathBound, registeredDigest] of [["no-path canonical", false, CANONICAL_HASH], ["path-bound raw", true, RAW_DIGEST]] as const) {
    it(`refuses a tampered wrapped key against a ${kind} registration`, async () => {
      // Another key whose canonical envelope hash is recomputed, so only the registered digest can catch it.
      const f = await fixture({ pathBound, registeredDigest, wrappedKeyBase64: base64(Uint8Array.from([1, 2, 3, 5])) });
      await expect(f.client.decryptV3Content(f.stored)).rejects.toThrow("encrypted content envelope binding is invalid");
      expect(f.decryptInvocations()).toBe(0);
    });

    it(`refuses a tampered digest against a ${kind} registration`, async () => {
      const f = await fixture({ pathBound, registeredDigest: registeredDigest.replace(/^./, (c) => (c === "0" ? "1" : "0")) });
      await expect(f.client.decryptV3Content(f.stored)).rejects.toThrow("encrypted content envelope binding is invalid");
      expect(f.decryptInvocations()).toBe(0);
    });
  }
});
