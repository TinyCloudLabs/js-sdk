import { beforeAll, describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { createPrivateKey, sign } from "node:crypto";
import {
  canonicalHashHex,
  canonicalizeEncryptionJson,
  EncryptionService,
  TinyCloudNode,
  type DecryptResponseBody,
  type DecryptTransport,
  type EncryptionCrypto,
  type NetworkDescriptor,
} from "@tinycloud/node-sdk";
import {
  computeCid,
  invokeAny,
  vault_decrypt,
  vault_encrypt,
  vault_random_bytes,
  vault_sha256,
  vault_x25519_dh,
  vault_x25519_from_seed,
} from "@tinycloud/node-sdk-wasm";
import { checkServerHealth, SERVER_URL, TEST_KEY } from "../setup";

type Canonicalizable = Parameters<typeof canonicalizeEncryptionJson>[0];

const NETWORK_CREATE_ACTION = "tinycloud.encryption/network.create";
const DECRYPT_ACTION = "tinycloud.encryption/decrypt";
const NETWORK_ADMIN_TYPE = "tinycloud.encryption.network-admin/v1";

function wrapToPublicKey(
  publicKey: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
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

function unwrapWithPrivateKey(
  privateKey: Uint8Array,
  wrapped: Uint8Array,
): Uint8Array {
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
    vault_x25519_from_seed(seed) as {
      publicKey: Uint8Array;
      privateKey: Uint8Array;
    },
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
    body: canonicalizeEncryptionJson(body as Canonicalizable),
  });
  if (!response.ok) {
    throw new Error(
      `${path} failed ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function postCanonicalJson<T>(
  path: string,
  authorization: string,
  body: string,
): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `${path} failed ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return new Uint8Array(Buffer.from(normalized + padding, "base64"));
}

function rewriteInvocationAudience(
  authorization: string,
  audience: string,
  jwk: object,
): string {
  const [headerPart, payloadPart] = authorization.split(".");
  if (!headerPart || !payloadPart) {
    throw new Error("invalid authorization template");
  }

  const header = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(headerPart)),
  ) as Record<string, unknown>;
  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadPart)),
  ) as Record<string, unknown>;
  payload.aud = audience;

  const signingInput = `${base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  )}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function mintRawNetworkAuthorization(
  session: unknown,
  nodeId: string,
  networkId: string,
  action: string,
  facts: unknown,
): {
  authorization: string;
  entry: {
    resource: string;
    service: string;
    path: string;
    action: string;
  };
  invocationCid: string;
} {
  const entry = {
    resource: networkId,
    service: "encryption",
    path: networkId,
    action,
  };
  const authorization = (
    invokeAny(session, [entry], [facts]) as { Authorization: string }
  ).Authorization;
  const sessionJwk = (session as { jwk: object }).jwk;
  const rewrittenAuthorization = rewriteInvocationAudience(
    authorization,
    nodeId,
    sessionJwk,
  );
  return {
    authorization: rewrittenAuthorization,
    entry,
    invocationCid: computeCid(
      new TextEncoder().encode(rewrittenAuthorization),
      0x55n,
    ),
  };
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

  test("decrypts through the public EncryptionService using raw network resources", async () => {
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
          actions: ["network.create", "decrypt"],
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
    const createAuth = mintRawNetworkAuthorization(
      session,
      nodeId,
      networkId,
      NETWORK_CREATE_ACTION,
      createFacts,
    );
    expect(createAuth.entry.resource).toBe(networkId);
    expect("spaceId" in createAuth.entry).toBe(false);

    const created = await postJson<{ descriptor: NetworkDescriptor }>(
      "/encryption/networks",
      createAuth.authorization,
      createBody,
    );
    const descriptor = created.descriptor;
    expect(descriptor.networkId).toBe(networkId);
    expect(descriptor.members[0]?.nodeId).toBe(nodeId);

    let decryptEntry: {
      resource: string;
      service: string;
      path: string;
      action: string;
    } | null = null;

    const transport: DecryptTransport = {
      postDecrypt: async ({ authorization, canonicalBody }) =>
        postCanonicalJson<DecryptResponseBody>(
          `/encryption/networks/${encodeURIComponent(networkId)}/decrypt`,
          authorization,
          canonicalBody,
        ),
    };

    const service = new EncryptionService({
      crypto,
      signer: {
        signDecryptInvocation: async (input) => {
          const minted = mintRawNetworkAuthorization(
            session,
            nodeId,
            input.networkId,
            DECRYPT_ACTION,
            input.facts,
          );
          decryptEntry = minted.entry;
          return {
            authorization: minted.authorization,
            invocationCid: minted.invocationCid,
            canonicalBody: canonicalizeEncryptionJson(
              input.body as Canonicalizable,
            ),
          };
        },
      },
      transport,
      node: {
        fetchByNetworkId: async (requestedNetworkId) =>
          requestedNetworkId === networkId ? descriptor : null,
      },
    });

    const plaintext = new TextEncoder().encode(
      "tinycloud encryption live test",
    );
    const encryptResult = await service.encryptToNetwork(networkId, plaintext);
    expect(encryptResult.ok).toBe(true);
    if (!encryptResult.ok) return;

    const decryptResult = await service.decryptEnvelope(
      encryptResult.data,
      { proofs: [session.delegationCid] },
      { descriptor, targetNode: nodeId },
    );
    expect(decryptResult.ok).toBe(true);
    if (!decryptResult.ok) {
      throw new Error(decryptResult.error.message);
    }

    expect(new TextDecoder().decode(decryptResult.data)).toBe(
      "tinycloud encryption live test",
    );
    expect(decryptEntry).not.toBeNull();
    expect("spaceId" in decryptEntry!).toBe(false);
    expect(decryptEntry?.resource).toBe(networkId);
    expect(decryptEntry?.service).toBe("encryption");
    expect(decryptEntry?.path).toBe(networkId);
    expect(decryptEntry?.action).toBe(DECRYPT_ACTION);
  });
});
