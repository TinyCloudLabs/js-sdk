import { describe, expect, test } from "bun:test";

import {
  base64Decode,
  base64Encode,
  canonicalHashHex,
  canonicalize,
  hexEncode,
  utf8Encode,
} from "./canonical";
import { EncryptionService } from "./EncryptionService";
import {
  DECRYPT_RESULT_TYPE,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type EncryptionCrypto,
  type InlineEncryptedEnvelope,
  type NetworkDescriptor,
} from "./types";

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

function httpFailure(status: number): Error & { status: number } {
  const error = new Error("raw transport message canary") as Error & {
    status: number;
  };
  error.status = status;
  Object.defineProperty(
    error,
    Symbol.for("@tinycloud/sdk-services/decrypt-transport-response"),
    { value: true },
  );
  return error;
}

function validResponse(
  crypto: EncryptionCrypto,
  canonicalBody: string,
): DecryptResponseBody {
  const request = JSON.parse(canonicalBody) as DecryptRequestBody;
  const symmetricKey = xor(
    NETWORK_KEY,
    base64Decode(request.encryptedSymmetricKey),
  );
  const wrappedKey = xor(base64Decode(request.receiverPublicKey), symmetricKey);
  const invocationCid = "bafy-encryption-classification";
  const requestBodyHash = canonicalHashHex(crypto.sha256, request as never);
  return {
    type: DECRYPT_RESULT_TYPE,
    targetNode: request.targetNode,
    networkId: request.networkId,
    invocationCid,
    encryptedSymmetricKeyHash: request.encryptedSymmetricKeyHash,
    receiverPublicKeyHash: request.receiverPublicKeyHash,
    wrappedKey: base64Encode(wrappedKey),
    alg: request.alg,
    keyVersion: request.keyVersion,
    requestHash: hexEncode(
      crypto.sha256(utf8Encode(`${invocationCid}${requestBodyHash}`)),
    ),
    nodeId: TARGET_NODE,
    nodeSignature: base64Encode(new Uint8Array(64)),
  };
}

async function decryptWith(
  options: {
    localDecryptFails?: boolean;
    sign?: () => Promise<never>;
    post: (canonicalBody: string, crypto: EncryptionCrypto) => Promise<DecryptResponseBody>;
  },
) {
  const serviceCrypto = crypto(options.localDecryptFails);
  const service = new EncryptionService({
    crypto: serviceCrypto,
    signer: {
      signDecryptInvocation: async (input) => {
        if (options.sign) return options.sign();
        return {
          authorization: "authorization-canary",
          invocationCid: "bafy-encryption-classification",
          canonicalBody: canonicalize(input.body as never),
        };
      },
    },
    transport: {
      postDecrypt: async ({ canonicalBody }) => options.post(canonicalBody, serviceCrypto),
    },
    node: { fetchByNetworkId: async () => descriptor() },
  });
  const encrypted = await service.encryptToNetwork(NETWORK_ID, utf8Encode("secret-value-canary"));
  expect(encrypted.ok).toBe(true);
  if (!encrypted.ok) throw new Error("test fixture encryption failed");
  return service.decryptEnvelope(encrypted.data as InlineEncryptedEnvelope, { proofs: [] });
}

describe("EncryptionService decrypt failure classification", () => {
  test.each([401, 403])("maps tagged HTTP %i to DECRYPT_DENIED", async (status) => {
    const result = await decryptWith({
      post: async () => {
        throw httpFailure(status);
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "DECRYPT_DENIED" } });
  });

  test("maps other tagged HTTP failures and malformed responses to INVALID_RESPONSE", async () => {
    const httpResult = await decryptWith({
      post: async () => {
        throw httpFailure(500);
      },
    });
    expect(httpResult).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });

    const malformedResult = await decryptWith({
      post: async () => ({}) as DecryptResponseBody,
    });
    expect(malformedResult).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });

  test("maps generic transport, signing, and local decrypt failures without transport text", async () => {
    const transportResult = await decryptWith({
      post: async () => {
        throw new Error("generic transport canary");
      },
    });
    expect(transportResult).toMatchObject({ ok: false, error: { code: "TRANSPORT_ERROR" } });

    const signingResult = await decryptWith({
      sign: async () => {
        throw new Error("signing canary");
      },
      post: async (canonicalBody, serviceCrypto) => validResponse(serviceCrypto, canonicalBody),
    });
    expect(signingResult).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

    const decryptResult = await decryptWith({
      localDecryptFails: true,
      post: async (canonicalBody, serviceCrypto) => validResponse(serviceCrypto, canonicalBody),
    });
    expect(decryptResult).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    expect(JSON.stringify(decryptResult)).not.toContain("canary");
  });
});
