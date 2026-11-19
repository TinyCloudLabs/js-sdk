import { describe, expect, test } from "bun:test";

import { NodeIdentityMismatchError, NodeNotRespondingError, PartialNodeWriteError } from "../resourceRouting";
import {
  base64Decode,
  base64Encode,
  canonicalHashHex,
  canonicalize,
  hexEncode,
  utf8Encode,
} from "./canonical";
import {
  DecryptTransportResponseError,
  EncryptionService,
} from "./EncryptionService";
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

function httpFailure(status: number): DecryptTransportResponseError {
  return new DecryptTransportResponseError(status);
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
    discover?: () => Promise<NetworkDescriptor | null>;
    resolveTargetNode?: () => Promise<string>;
    post?: (canonicalBody: string, crypto: EncryptionCrypto) => Promise<DecryptResponseBody>;
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
      postDecrypt: async ({ canonicalBody }) => options.post
        ? options.post(canonicalBody, serviceCrypto)
        : validResponse(serviceCrypto, canonicalBody),
    },
    node: { fetchByNetworkId: async () => descriptor() },
  });
  const encrypted = await service.encryptToNetwork(NETWORK_ID, utf8Encode("secret-value-canary"));
  expect(encrypted.ok).toBe(true);
  if (!encrypted.ok) throw new Error("test fixture encryption failed");
  if (options.discover) service.config.node = { fetchByNetworkId: options.discover };
  if (options.resolveTargetNode) service.config.resolveTargetNode = options.resolveTargetNode;
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

  test("does not trust marker-shaped transport errors", async () => {
    const result = await decryptWith({
      post: async () => {
        const error = new Error("spoofed response canary") as Error & { status: number };
        error.status = 403;
        Object.defineProperty(
          error,
          Symbol.for("@tinycloud/sdk-services/decrypt-transport-response"),
          { value: true },
        );
        throw error;
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "DECRYPTION_DEPENDENCY_UNAVAILABLE" } });
  });

  test("maps generic transport, signing, and local decrypt failures without transport text", async () => {
    const transportResult = await decryptWith({
      post: async () => {
        throw new Error("generic transport canary");
      },
    });
    expect(transportResult).toMatchObject({ ok: false, error: { code: "DECRYPTION_DEPENDENCY_UNAVAILABLE" } });

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

  test.each(["descriptor", "identity", "decrypt"] as const)("names the unavailable decryption dependency at %s without returning plaintext", async (phase) => {
    const fail = async (): Promise<never> => { throw new NodeNotRespondingError(["https://decryption.fixture.invalid"]); };
    const result = await decryptWith({
      ...(phase === "descriptor" ? { discover: fail } : {}),
      ...(phase === "identity" ? { resolveTargetNode: fail } : {}),
      ...(phase === "decrypt" ? { post: fail } : {}),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "DECRYPTION_DEPENDENCY_UNAVAILABLE" } });
    expect(result).not.toHaveProperty("data");
    if (!result.ok) expect(result.error.message).toMatch(/decryption service/i);
  });

  test("keeps one transient decrypt503 an invalid-response failure without retry or plaintext", async () => {
    let requests = 0;
    const result = await decryptWith({ post: async (canonicalBody, serviceCrypto) => {
      if (++requests === 1) throw httpFailure(503);
      return validResponse(serviceCrypto, canonicalBody);
    } });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    expect(result).not.toHaveProperty("data");
    expect(requests).toBe(1);
  });

  test("preserves identity, registry, data-partial and caller-cancellation classifications", async () => {
    for (const error of [
      new NodeIdentityMismatchError("https://wrong.fixture.invalid", TARGET_NODE),
      { code: "registry_unavailable", message: "registry unavailable" },
      new PartialNodeWriteError(["https://accepted.fixture.invalid"], [{ url: "https://offline.fixture.invalid", cause: new NodeNotRespondingError([]) }]),
    ]) {
      const result = await decryptWith({ post: async () => { throw error; } });
      expect(result).toMatchObject({ ok: false, error: { code: error.code } });
      expect(result).not.toHaveProperty("data");
    }
    const aborted = new DOMException("caller cancelled", "AbortError");
    const result = await decryptWith({ post: async () => { throw aborted; } });
    expect(result).toMatchObject({ ok: false, error: { code: "TRANSPORT_ERROR", cause: aborted } });
  });
});
