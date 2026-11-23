import { expect, test } from "bun:test";
import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "node:crypto";
import { base64Decode, base64Encode, utf8Encode } from "./canonical";
import { KEY_WRAP_V2_ALG, openKeyV2 } from "./keyWrap";
import { NamedKeyClient, type KeyDescriptor, type PublicKeyDescriptor } from "./namedKeys";
import { DEFAULT_ENCRYPTION_ALG } from "./types";

const privateKey = new Uint8Array(32).fill(7);
const networkId = "urn:tinycloud:encryption:did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed:default";
const keyPath = "secrets/scoped/tinychat-bot-history/bot-history";
const publicDescriptor: PublicKeyDescriptor = {
  networkId, keyPath, alg: DEFAULT_ENCRYPTION_ALG, keyVersion: 2,
  publicEncryptionKey: base64Encode(x25519.getPublicKey(privateKey)),
};
const descriptor: KeyDescriptor = { ...publicDescriptor, state: "active", kind: "deletable" };
const unused = (): never => { throw new Error("unexpected cryptographic operation"); };
const nonceBytes = 12;

function client() {
  let transportCalls = 0;
  const unexpectedTransport = async (): Promise<never> => {
    transportCalls++;
    throw new Error("a pinned descriptor must not contact or sign for a node");
  };
  return {
    calls: () => transportCalls,
    perform: new NamedKeyClient({
      host: "http://127.0.0.1:1", defaultNetworkId: () => networkId,
      fetch: unexpectedTransport as typeof fetch, signInvocation: unexpectedTransport,
      crypto: {
        randomBytes, sha256,
        x25519FromSeed: unused, x25519Dh: unused, openWithReceiverKey: unused,
        verifyNodeSignature: unused, authDecrypt: unused,
        authEncrypt(key, bytes, aad) {
          const nonce = randomBytes(nonceBytes);
          return Buffer.concat([nonce, gcm(key, nonce, aad).encrypt(bytes)]);
        },
        sealToNetworkKey(publicKey, bytes) {
          const ephemeral = randomBytes(32);
          const nonce = randomBytes(nonceBytes);
          const shared = x25519.getSharedSecret(ephemeral, publicKey);
          return Buffer.concat([x25519.getPublicKey(ephemeral), Uint8Array.of(1), nonce, gcm(shared, nonce).encrypt(bytes)]);
        },
      },
    }),
  };
}

test.each([false, true])("a pinned descriptor produces a readable envelope with keyWrapV2=%s and no node access", async (keyWrapV2) => {
  const h = client();
  const plaintext = utf8Encode("bot-history fixture");
  const aad = utf8Encode("history binding");
  const metadata = { contentType: "text/plain" };

  const envelope = await h.perform.encrypt(keyPath, plaintext, {
    descriptor, aad, metadata, keyWrapV2,
  });
  expect(envelope).toMatchObject({ v: 2, networkId, keyPath, keyVersion: 2, aad: base64Encode(aad), metadata,
    alg: keyWrapV2 ? KEY_WRAP_V2_ALG : DEFAULT_ENCRYPTION_ALG });
  const wrapped = base64Decode(envelope.encryptedSymmetricKey);
  const symmetricKey = keyWrapV2
    ? openKeyV2(privateKey, wrapped, { purpose: "network-key", networkId, keyPath, keyVersion: 2, metadata })
    : gcm(x25519.getSharedSecret(privateKey, wrapped.subarray(0, 32)), wrapped.subarray(33, 45)).decrypt(wrapped.subarray(45));
  const ciphertext = base64Decode(envelope.ciphertext);
  expect(gcm(symmetricKey, ciphertext.subarray(0, nonceBytes), aad).decrypt(ciphertext.subarray(nonceBytes))).toEqual(plaintext);
  expect(h.calls()).toBe(0);
});

test("a seeded key requires both state and kind in the pinned descriptor", async () => {
  const h = client();
  for (const missingMetadata of [publicDescriptor, { ...publicDescriptor, state: "active" }, { ...publicDescriptor, kind: "deletable" }]) {
    await expect(h.perform.encrypt(keyPath, new Uint8Array(1), { descriptor: missingMetadata })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  }
  expect(h.calls()).toBe(0);
});

test("a deterministic key can use a public descriptor without state and kind", async () => {
  const h = client();
  const path = "share/bot-history-fixture";
  const envelope = await h.perform.encrypt(path, utf8Encode("fixture"), { descriptor: { ...publicDescriptor, keyPath: path } });
  expect(envelope).toMatchObject({ v: 2, networkId, keyPath: path });
  expect(h.calls()).toBe(0);
});

test.each([
  [{ networkId: networkId.replace(":default", ":other") }, "INVALID_RESPONSE"],
  [{ keyPath: `${keyPath}-other` }, "INVALID_RESPONSE"],
  [{ state: "blocked" }, "KEY_BLOCKED"],
  [{ state: "deleted" }, "KEY_UNAVAILABLE"],
  [{ kind: "deterministic" }, "KEY_KIND_MISMATCH"],
  [{ keyVersion: 0 }, "INVALID_RESPONSE"],
  [{ keyVersion: 1.5 }, "INVALID_RESPONSE"],
  [{ publicEncryptionKey: "not base64" }, "INVALID_RESPONSE"],
  [{ publicEncryptionKey: "AQID" }, "INVALID_RESPONSE"],
  [{ publicEncryptionKey: `${descriptor.publicEncryptionKey}\n` }, "INVALID_RESPONSE"],
] as const)("rejects an unusable descriptor (%j) without asking the node", async (invalid, code) => {
  const h = client();
  await expect(h.perform.encrypt(keyPath, new Uint8Array(1), { descriptor: { ...descriptor, ...invalid } })).rejects.toMatchObject({ code });
  expect(h.calls()).toBe(0);
});

test("a supplied descriptor cannot ask to ensure a key", async () => {
  const h = client();
  await expect(h.perform.encrypt(keyPath, new Uint8Array(1), { descriptor, ensureKey: true })).rejects.toMatchObject({ code: "INVALID_KEY_TARGET" });
  expect(h.calls()).toBe(0);
});
