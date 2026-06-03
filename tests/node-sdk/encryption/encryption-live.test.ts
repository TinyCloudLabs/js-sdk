import { beforeAll, describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  invokeAny,
  vault_decrypt,
  vault_encrypt,
  vault_random_bytes,
  vault_sha256,
  vault_x25519_dh,
  vault_x25519_from_seed,
} from "@tinycloud/node-sdk-wasm";
import {
  base64Decode,
  base64Encode,
  buildCanonicalDecryptRequest,
  buildDecryptFacts,
  canonicalHashHex,
  decryptEnvelopeWithKey,
  encryptToNetwork,
  generateRandomReceiverKey,
  openWrappedKey,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type EncryptionCrypto,
} from "@tinycloud/sdk-services/encryption";
import { checkServerHealth, SERVER_URL, TEST_KEY } from "../setup";

const NETWORK_CREATE_ACTION = "tinycloud.encryption/network.create";
const DECRYPT_ACTION = "tinycloud.encryption/decrypt";
const NETWORK_ADMIN_TYPE = "tinycloud.encryption.network-admin/v1";
const DECRYPT_TYPE = "tinycloud.encryption.decrypt/v1";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
}

function wrapToPublicKey(publicKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const seed = vault_random_bytes(32);
  const ephemeral = vault_x25519_from_seed(seed) as {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  };
  const shared = vault_x25519_dh(ephemeral.privateKey, publicKey);
  const encrypted = columnEncrypt(shared, plaintext);
  const out = new Uint8Array(ephemeral.publicKey.length + encrypted.length);
  out.set(ephemeral.publicKey, 0);
  out.set(encrypted, ephemeral.publicKey.length);
  return out;
}

function unwrapWithPrivateKey(privateKey: Uint8Array, wrapped: Uint8Array): Uint8Array {
  const peerPublic = wrapped.slice(0, 32);
  const ciphertext = wrapped.slice(32);
  const shared = vault_x25519_dh(privateKey, peerPublic);
  return columnDecrypt(shared, ciphertext);
}

function columnEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const encrypted = vault_encrypt(key, plaintext);
  const out = new Uint8Array(1 + encrypted.length);
  out[0] = 0x01;
  out.set(encrypted, 1);
  return out;
}

function columnDecrypt(key: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob[0] !== 0x01) return blob;
  return vault_decrypt(key, blob.slice(1));
}

const crypto: EncryptionCrypto = {
  sha256: (data) => vault_sha256(data),
  randomBytes: (length) => vault_random_bytes(length),
  x25519FromSeed: (seed) =>
    vault_x25519_from_seed(seed) as { publicKey: Uint8Array; privateKey: Uint8Array },
  x25519Dh: (privateKey, publicKey) => vault_x25519_dh(privateKey, publicKey),
  authEncrypt: (key, plaintext) => vault_encrypt(key, plaintext),
  authDecrypt: (key, ciphertext) => vault_decrypt(key, ciphertext),
  sealToNetworkKey: wrapToPublicKey,
  openWithReceiverKey: unwrapWithPrivateKey,
  verifyNodeSignature: () => true,
};

async function postJson<T>(
  path: string,
  authorization: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: canonicalize(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

describe("encryption live node-sdk integration", () => {
  let nodeId: string;

  beforeAll(async () => {
    await checkServerHealth();
    const info = (await (await fetch(`${SERVER_URL}/info`)).json()) as {
      nodeId: string;
    };
    nodeId = info.nodeId;
  });

  test("creates a network and decrypts through node-sdk invokeAny", async () => {
    const wallet = new Wallet(TEST_KEY);
    const principal = `did:pkh:eip155:1:${wallet.address}`;
    const networkName = `sdk-live-${Date.now()}`;
    const networkId = `urn:tinycloud:encryption:${principal}:${networkName}`;
    const manifest = {
      manifest_version: 1 as const,
      app_id: "dev.tinycloud.encryption-live",
      name: "TinyCloud Encryption Live Test",
      defaults: false,
      permissions: [
        {
          service: "tinycloud.encryption",
          path: networkId,
          actions: ["network.create", "network.revoke", "decrypt"],
        },
      ],
    };

    const alice = new TinyCloudNode({
      privateKey: TEST_KEY,
      host: SERVER_URL,
      prefix: `encryption-live-${Date.now()}`,
      autoCreateSpace: true,
      manifest,
      includeAccountRegistryPermissions: false,
    });
    await alice.signIn();
    const session = alice.session;
    if (!session) throw new Error("missing session after signIn");

    const createBody = {
      name: networkName,
      principal,
      threshold: { n: 1, t: 1 },
    };
    const createFacts = {
      type: NETWORK_ADMIN_TYPE,
      targetNode: nodeId,
      networkId,
      bodyHash: canonicalHashHex(crypto.sha256, createBody),
      action: NETWORK_CREATE_ACTION,
    };
    const createAuth = invokeAny(
      session,
      [
        {
          resource: networkId,
          spaceId: session.spaceId,
          service: "encryption",
          path: networkId,
          action: NETWORK_CREATE_ACTION,
        },
      ],
      [createFacts],
    ) as { Authorization: string };

    const created = await postJson<{ descriptor: { publicEncryptionKey: string } }>(
      "/encryption/networks",
      createAuth.Authorization,
      createBody,
    );

    const plaintext = new TextEncoder().encode("tinycloud encryption live test");
    const { envelope } = encryptToNetwork(crypto, {
      networkId,
      networkPublicKey: base64Decode(created.descriptor.publicEncryptionKey),
      plaintext,
    });

    const receiverKey = generateRandomReceiverKey({ crypto });
    const receiverPublicKey = base64Encode(receiverKey.publicKey);
    const body: DecryptRequestBody = {
      type: DECRYPT_TYPE,
      targetNode: nodeId,
      networkId,
      alg: envelope.alg,
      keyVersion: envelope.keyVersion,
      encryptedSymmetricKey: envelope.encryptedSymmetricKey,
      encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash,
      receiverPublicKey,
      receiverPublicKeyHash: canonicalHashHex(crypto.sha256, receiverPublicKey),
    };
    const canonicalRequest = buildCanonicalDecryptRequest({
      crypto,
      body,
      receiverPublicKey: receiverKey.publicKey,
    });
    const decryptFacts = buildDecryptFacts({
      crypto,
      body,
      encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash,
      receiverPublicKey: receiverKey.publicKey,
      canonicalBody: canonicalRequest.canonicalBody,
    });
    const decryptAuth = invokeAny(
      session,
      [
        {
          resource: networkId,
          spaceId: session.spaceId,
          service: "encryption",
          path: networkId,
          action: DECRYPT_ACTION,
        },
      ],
      [decryptFacts],
    ) as { Authorization: string };

    const response = await postJson<DecryptResponseBody>(
      `/encryption/networks/${encodeURIComponent(networkId)}/decrypt`,
      decryptAuth.Authorization,
      body,
    );

    expect(response.networkId).toBe(networkId);
    expect(response.nodeId).toBe(nodeId);
    expect(response.encryptedSymmetricKeyHash).toBe(
      envelope.encryptedSymmetricKeyHash,
    );
    if (typeof response.wrappedKey !== "string") {
      throw new Error(`missing wrappedKey in ${JSON.stringify(response)}`);
    }

    let symmetricKey: Uint8Array;
    try {
      symmetricKey = openWrappedKey(crypto, receiverKey.privateKey, response);
    } catch (error) {
      throw new Error(
        `failed to open node rewrap: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let recovered: Uint8Array;
    try {
      recovered = decryptEnvelopeWithKey(crypto, envelope, symmetricKey);
    } catch (error) {
      throw new Error(
        `failed to decrypt envelope: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    expect(new TextDecoder().decode(recovered)).toBe(
      "tinycloud encryption live test",
    );
  });
});
