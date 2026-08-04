import { describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize, didKeyFromEd25519PublicKey, signCompactUcanAuthorization, toBase64Url, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { ShareRecipientClient } from "../src/recipient.js";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const canonicalHash = (value: unknown): string => hex(sha256(new TextEncoder().encode(canonicalize(value))));

async function aesEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, plaintext as BufferSource));
  return Uint8Array.from([...nonce, ...encrypted]);
}

describe("v3 recipient content", () => {
  it("verifies the node response, decrypts locally, and keeps edits encrypted", async () => {
    const recipientKey = new Uint8Array(32).fill(9);
    const nodeKey = new Uint8Array(32).fill(8);
    const recipientDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(recipientKey));
    const nodeDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(nodeKey));
    const networkId = "urn:tinycloud:encryption:did:key:zOwner:default";
    const encryptedSymmetricKey = "network-wrapped-key";
    const encryptedSymmetricKeyHash = canonicalHash(encryptedSymmetricKey);
    const now = Math.floor(Date.now() / 1000);
    const session = await signCompactUcanAuthorization({ issuerDid: nodeDid, audienceDid: recipientDid, attenuation: { [networkId]: { "tinycloud.encryption/decrypt": [{}] } }, facts: [{ profile: "policy-session-ucan/v1", policyCid: "policy", recipientDid }], proofs: ["policy-root", "enforcement-root"], notBefore: now - 1, expiresAt: now + 59, nonce: "session", sign: async (bytes) => ed25519.sign(bytes, nodeKey) });
    const symmetricKey = new Uint8Array(32).fill(41);
    const ciphertext = await aesEncrypt(symmetricKey, new TextEncoder().encode("hello"));
    const stored = new TextEncoder().encode(canonicalize({ v: 1, networkId, alg: "x25519-aes256gcm/v1", keyVersion: 1, encryptedSymmetricKey, encryptedSymmetricKeyHash, ciphertext: toBase64Url(ciphertext), metadata: { contentType: "text/plain" } }));
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const receiverPublicKey = Uint8Array.from(Buffer.from(String(body.receiverPublicKey), "base64url"));
      const ephemeralPrivate = new Uint8Array(32).fill(23);
      const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
      const shared = x25519.getSharedSecret(ephemeralPrivate, receiverPublicKey);
      const wrapped = await aesEncrypt(shared, symmetricKey);
      const invocation = verifyCompactUcanAuthorization(new Headers(init?.headers).get("Authorization")!);
      const bodyHash = canonicalHash(body);
      const unsigned = { type: "tinycloud.encryption.decrypt-result/v1", targetNode: nodeDid, networkId, invocationCid: invocation.cid, encryptedSymmetricKeyHash, receiverPublicKeyHash: body.receiverPublicKeyHash, wrappedKey: base64(Uint8Array.from([...ephemeralPublic, ...wrapped])), alg: "x25519-aes256gcm/v1", keyVersion: 1, requestHash: hex(sha256(new TextEncoder().encode(`${invocation.cid}${bodyHash}`))), nodeId: nodeDid };
      return Response.json({ ...unsigned, nodeSignature: base64(ed25519.sign(new TextEncoder().encode(canonicalize(unsigned)), nodeKey)) });
    };
    const envelope = { version: 3, target: { nodeAudience: nodeDid }, encryptionNetwork: networkId, contentSource: { keyVersion: 1, encryptedSymmetricKeyDigestHex: encryptedSymmetricKeyHash }, metadata: { mediaType: "text/plain" } } as any;
    const client = new ShareRecipientClient({ nodeOrigin: "https://node.example.com", envelope, holderDid: recipientDid, trustedNode: {} as any, fetchFn, buildPresentation: async () => ({ holderDid: recipientDid, credential: "fixture", holderBinding: {}, proof: {} }) });
    Object.assign(client as any, { session: { sessionId: session.cid }, v3Authorization: session.authorization, nativeSigner: async (bytes: Uint8Array) => ed25519.sign(bytes, recipientKey) });

    const opened = await client.decryptV3Content(stored);
    expect(new TextDecoder().decode(opened.bytes)).toBe("hello");
    expect(opened.mediaType).toBe("text/plain");
    expect(new TextDecoder().decode(await client.encryptV3Content(new TextEncoder().encode("edited"), "text/plain"))).not.toContain("edited");
  });
});
