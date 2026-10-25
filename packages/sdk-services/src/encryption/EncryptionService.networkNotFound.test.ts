import { mkdtempSync, rmSync } from "node:fs";
import { describe, expect, test, afterAll } from "bun:test";
import { discoverNetwork } from "./discovery";
import { encryptionError } from "./types";


import { base64Encode, canonicalize, utf8Encode } from "./canonical";
import {
  DecryptTransportResponseError,
  EncryptionService,
} from "./EncryptionService";
import {
  type EncryptionCrypto,
  type InlineEncryptedEnvelope,
  type NetworkDescriptor,
} from "./types";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const tc1910Home = mkdtempSync("/var/tmp/tc1910.");
if (!tc1910Home.startsWith("/var/tmp/tc1910.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = tc1910Home;
}
afterAll(() => rmSync(tc1910Home, { recursive: true, force: true }));


const NETWORK_ID = "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";
const TARGET_NODE = "did:key:z6MkNode";
const NETWORK_KEY = new Uint8Array(32).fill(7);

function xor(key: Uint8Array, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index++) {
    output[index] = data[index] ^ key[index % key.length];
  }
  return output;
}

function sha256(data: Uint8Array): Uint8Array {
  const output = new Uint8Array(32);
  let left = 0x6a09e667;
  let right = 0xbb67ae85;
  for (const byte of data) {
    left = ((left + byte * 31) ^ ((left << 5) | (left >>> 27))) >>> 0;
    right = ((right ^ (byte + 17)) + ((right << 7) | (right >>> 25))) >>> 0;
  }
  for (let index = 0; index < 16; index++) {
    output[index] = (left >>> ((index % 4) * 8)) & 0xff;
    output[index + 16] = (right >>> ((index % 4) * 8)) & 0xff;
    left = (left * 1103515245 + 12345) >>> 0;
    right = (right * 1664525 + 1013904223) >>> 0;
  }
  return output;
}

function descriptor(): NetworkDescriptor {
  return {
    networkId: NETWORK_ID,
    ownerDid: "did:key:z6MkPrincipal",
    name: "default",
    members: [{ nodeId: TARGET_NODE, role: "primary" }],
    threshold: { n: 1, t: 1 },
    state: "active",
    publicEncryptionKey: base64Encode(NETWORK_KEY),
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    keyBackend: "local-one-of-one",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function crypto(localDecryptFails = false): EncryptionCrypto {
  let seed = 1;
  return {
    sha256,
    randomBytes: (length) => {
      const result = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        result[index] = seed++;
      }
      return result;
    },
    x25519FromSeed: (seedBytes) => ({
      publicKey: seedBytes,
      privateKey: seedBytes,
    }),
    x25519Dh: (privateKey, publicKey) => sha256(xor(privateKey, publicKey)),
    authEncrypt: (key, plaintext) => xor(key, plaintext),
    authDecrypt: (key, ciphertext) => {
      if (localDecryptFails) throw new Error("local decrypt canary");
      return xor(key, ciphertext);
    },
    sealToNetworkKey: (networkPublicKey, symmetricKey) =>
      xor(networkPublicKey, symmetricKey),
    openWithReceiverKey: (receiverPrivateKey, wrappedKey) =>
      xor(receiverPrivateKey, wrappedKey),
    verifyNodeSignature: () => true,
  };
}

/**
 * A decrypt that the node answers with 404 maps to NETWORK_NOT_FOUND. The
 * sign-in-again advice appears only when the transport supplies it (the
 * signed-in owner's own default network), never from the default text (TC-1910).
 */
async function decrypt404(transportError: DecryptTransportResponseError) {
  const service = new EncryptionService({
    crypto: crypto(),
    signer: {
      signDecryptInvocation: async (input) => ({
        authorization: "authorization-canary",
        invocationCid: "bafy-network-missing",
        canonicalBody: canonicalize(input.body as never),
      }),
    },
    transport: {
      postDecrypt: async () => {
        throw transportError;
      },
    },
    node: { fetchByNetworkId: async () => descriptor() },
  });
  const encrypted = await service.encryptToNetwork(NETWORK_ID, utf8Encode("value"));
  if (!encrypted.ok) throw new Error("fixture encryption failed");
  const result = await service.decryptEnvelope(encrypted.data as InlineEncryptedEnvelope, { proofs: [] });
  if (result.ok) throw new Error("expected failure");
  return result.error;
}

test("decrypt 404 with transport advice keeps the sign-in-again hint", async () => {
  const error = await decrypt404(
    new DecryptTransportResponseError(404, undefined, `Network not found: ${NETWORK_ID}. Sign in again with a current SDK.`),
  );
  expect(error).toMatchObject({ code: "NETWORK_NOT_FOUND", networkId: NETWORK_ID });
  expect(error.message).toContain("Sign in again with a current SDK");
});

test("decrypt 404 without transport advice has the plain not-found text", async () => {
  const error = await decrypt404(new DecryptTransportResponseError(404));
  expect(error).toMatchObject({ code: "NETWORK_NOT_FOUND", networkId: NETWORK_ID });
  expect(error.message).toBe(`Network not found: ${NETWORK_ID}`);
});

describe("NETWORK_NOT_FOUND text carries no sign-in advice by default", () => {
  test("the generic message has no advice", () => {
    expect(encryptionError({ code: "NETWORK_NOT_FOUND", networkId: NETWORK_ID }).message).toBe(
      `Network not found: ${NETWORK_ID}`,
    );
  });

  test.each([
    ["a named network", "urn:tinycloud:encryption:did:key:z6MkPrincipal:team"],
    ["another owner's network", "urn:tinycloud:encryption:did:key:z6MkSomeoneElse:default"],
  ])("encrypt-time discovery of %s has no advice", async (_label, identifier) => {
    const found = await discoverNetwork({ identifier, node: { fetchByNetworkId: async () => null } });
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.code).toBe("NETWORK_NOT_FOUND");
    expect(found.error.message).not.toContain("Sign in again");
  });
});
