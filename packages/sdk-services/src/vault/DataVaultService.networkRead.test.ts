import { describe, expect, test } from "bun:test";

import { ServiceContext } from "../context";
import {
  base64Decode,
  base64Encode,
  canonicalHashHex,
  canonicalize,
  DecryptTransportResponseError,
  EncryptionService,
  hexEncode,
  utf8Encode,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type EncryptionCrypto,
  type NetworkDescriptor,
} from "../encryption";
import { KVService } from "../kv/KVService";
import { DataVaultService, type VaultCrypto } from "./DataVaultService";

const SPACE_ID = "tinycloud:pkh:eip155:1:0xabc:secrets";
const NETWORK_ID = "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";
const TARGET_NODE = "did:key:z6MkNode";
const NETWORK_PUBLIC_KEY = new Uint8Array(32).fill(7);

function xor(key: Uint8Array, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index++) {
    output[index] = data[index] ^ key[index % key.length];
  }
  return output;
}

function deterministicSha256(data: Uint8Array): Uint8Array {
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

function createEncryptionCrypto(onLocalDecrypt: () => boolean): EncryptionCrypto {
  let seed = 0xdeadbeef;
  return {
    sha256: deterministicSha256,
    randomBytes: (length) => {
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        output[index] = seed & 0xff;
      }
      return output;
    },
    x25519FromSeed: (seedBytes) => ({
      publicKey: seedBytes,
      privateKey: seedBytes,
    }),
    x25519Dh: (privateKey, publicKey) => deterministicSha256(xor(privateKey, publicKey)),
    authEncrypt: (key, plaintext) => xor(key, plaintext),
    authDecrypt: (key, ciphertext) => {
      if (onLocalDecrypt()) throw new Error("local authenticated decrypt failed");
      return xor(key, ciphertext);
    },
    sealToNetworkKey: (networkPublicKey, symmetricKey) =>
      xor(networkPublicKey, symmetricKey),
    openWithReceiverKey: (receiverPrivateKey, wrappedKey) =>
      xor(receiverPrivateKey, wrappedKey),
    verifyNodeSignature: () => true,
  };
}

function createVaultCrypto(): VaultCrypto {
  return {
    encrypt: (_key, plaintext) => plaintext,
    decrypt: (_key, ciphertext) => ciphertext,
    deriveKey: () => new Uint8Array(32),
    x25519FromSeed: (seed) => ({ publicKey: seed, privateKey: seed }),
    x25519Dh: (privateKey, publicKey) => xor(privateKey, publicKey),
    randomBytes: (length) => new Uint8Array(length),
    sha256: deterministicSha256,
  };
}

function descriptor(): NetworkDescriptor {
  return {
    networkId: NETWORK_ID,
    ownerDid: "did:key:z6MkPrincipal",
    name: "default",
    members: [{ nodeId: TARGET_NODE, role: "primary" }],
    threshold: { n: 1, t: 1 },
    state: "active",
    publicEncryptionKey: base64Encode(NETWORK_PUBLIC_KEY),
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    keyBackend: "local-one-of-one",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function decryptResponse(
  crypto: EncryptionCrypto,
  input: { canonicalBody: string },
): DecryptResponseBody {
  const request = JSON.parse(input.canonicalBody) as DecryptRequestBody;
  const symmetricKey = xor(
    NETWORK_PUBLIC_KEY,
    base64Decode(request.encryptedSymmetricKey),
  );
  const wrappedKey = xor(base64Decode(request.receiverPublicKey), symmetricKey);
  const invocationCid = "bafy-classified-read";
  const requestBodyHash = canonicalHashHex(crypto.sha256, request as any);
  return {
    type: "tinycloud.encryption.decrypt-result/v1",
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
    nodeSignature: base64Encode(new Uint8Array(64).fill(9)),
  };
}

function createClassifiedVault() {
  let localDecryptFails = false;
  let kvResponse = async () => new Response("missing", { status: 404 });
  let decrypt = async (input: { canonicalBody: string }) =>
    decryptResponse(crypto, input);
  const crypto = createEncryptionCrypto(() => localDecryptFails);
  const encryption = new EncryptionService({
    crypto,
    signer: {
      signDecryptInvocation: async (input) => ({
        authorization: "test-authorization",
        invocationCid: "bafy-classified-read",
        canonicalBody: canonicalize(input.body as any),
      }),
    },
    transport: { postDecrypt: (input) => decrypt(input) },
    node: { fetchByNetworkId: async () => descriptor() },
  });
  const context = new ServiceContext({
    hosts: ["https://tinycloud.test"],
    invoke: () => ({ Authorization: "test-authorization" }),
    fetch: async () => kvResponse() as any,
  });
  context.setSession({
    delegationHeader: { Authorization: "test-authorization" },
    delegationCid: "bafy-delegation",
    spaceId: SPACE_ID,
    verificationMethod: "did:key:z6MkSession",
    jwk: {},
  });
  const kv = new KVService();
  kv.initialize(context);
  const vault = new DataVaultService({
    spaceId: SPACE_ID,
    crypto: createVaultCrypto(),
    encryption: {
      networkId: NETWORK_ID,
      service: encryption,
      decryptCapabilityProof: { proofs: ["bafy-delegation"] },
    },
    tc: {
      kv,
      ensurePublicSpace: async () => ({ ok: true as const, data: undefined }),
      publicKV: kv,
      readPublicSpace: async () => ({ ok: true as const, data: undefined }),
      makePublicSpaceId: () => SPACE_ID,
      did: "did:key:z6MkPrincipal",
      address: "0xabc",
      chainId: 1,
      hosts: ["https://tinycloud.test"],
    },
  } as any);
  vault.initialize(context);

  return {
    vault,
    setKvResponse: (response: () => Promise<Response>) => {
      kvResponse = response;
    },
    setDecrypt: (response: (input: { canonicalBody: string }) => Promise<DecryptResponseBody>) => {
      decrypt = response;
    },
    setLocalDecryptFails: (value: boolean) => {
      localDecryptFails = value;
    },
    async encrypt(value: unknown): Promise<string> {
      const result = await encryption.encryptToNetwork(
        NETWORK_ID,
        utf8Encode(JSON.stringify(value)),
        { metadata: { "x-vault-content-type": "application/json" } },
      );
      if (!result.ok) throw new Error("test envelope encryption failed");
      return JSON.stringify(result.data);
    },
  };
}

describe("DataVaultService.readNetworkEncrypted", () => {
  test("classifies real KV and encryption paths without exposing error data", async () => {
    const fixture = createClassifiedVault();
    const secret = {
      value: "sensitive value canary",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    const envelope = await fixture.encrypt(secret);
    const encryptedResponse = () =>
      Promise.resolve(new Response(envelope, { status: 200 }));

    fixture.setKvResponse(() => Promise.resolve(new Response("missing key", { status: 404 })));
    expect(await fixture.vault.readNetworkEncrypted("secrets/API_KEY")).toEqual({
      status: "not_found",
    });

    fixture.setKvResponse(() =>
      Promise.resolve(new Response("Space not found", { status: 404 })),
    );
    expect(await fixture.vault.readNetworkEncrypted("secrets/API_KEY")).toEqual({
      status: "read_failed",
    });

    fixture.setKvResponse(() => Promise.resolve(new Response("node failure", { status: 500 })));
    expect(await fixture.vault.readNetworkEncrypted("secrets/API_KEY")).toEqual({
      status: "read_failed",
    });

    fixture.setKvResponse(async () => {
      throw new Error("fetch transport failure canary");
    });
    expect(await fixture.vault.readNetworkEncrypted("secrets/API_KEY")).toEqual({
      status: "node_unreachable",
    });

    fixture.setKvResponse(() => Promise.resolve(new Response("{}", { status: 200 })));
    expect(await fixture.vault.readNetworkEncrypted("secrets/API_KEY")).toEqual({
      status: "corrupt_envelope",
    });

    fixture.setKvResponse(encryptedResponse);
    expect(await fixture.vault.readNetworkEncrypted<typeof secret>("secrets/API_KEY")).toMatchObject({
      status: "ok",
      entry: { value: secret },
    });

    fixture.setLocalDecryptFails(true);
    expect(await fixture.vault.readNetworkEncrypted("secrets/API_KEY")).toEqual({
      status: "decrypt_failed",
    });
    fixture.setLocalDecryptFails(false);

    fixture.setDecrypt(async () => {
      throw new DecryptTransportResponseError(403);
    });
    expect(await fixture.vault.readNetworkEncrypted("secrets/API_KEY")).toEqual({
      status: "decrypt_failed",
    });

    fixture.setDecrypt(async () => {
      throw new Error("node transport failure canary");
    });
    const transport = await fixture.vault.readNetworkEncrypted("secrets/API_KEY");
    expect(transport).toEqual({ status: "node_unreachable" });
    expect(JSON.stringify(transport)).not.toContain("canary");
    expect(JSON.stringify(transport)).not.toContain("sensitive value");
  });
});
