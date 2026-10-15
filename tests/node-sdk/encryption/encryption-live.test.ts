import { beforeAll, describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { ed25519 } from "@noble/curves/ed25519";
import { createPrivateKey, sign } from "node:crypto";
import {
  canonicalHashHex,
  canonicalizeEncryptionJson,
  EncryptionService,
  TinyCloudNode,
  type DecryptResponseBody,
  type DecryptTransport,
  type EncryptionCrypto,
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
import { signCompactUcanAuthorization } from "@tinycloud/sdk-core/policy";
import { checkServerHealth, SERVER_URL } from "../setup";

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

  test("checks a revoked session key on encryption create, decrypt and revoke without affecting a new sign-in", async () => {
    const wallet = Wallet.createRandom();
    const ownerDid = `did:pkh:eip155:1:${wallet.address}`;
    const networkName = `sdk-live-${Date.now()}`;
    const networkId = `urn:tinycloud:encryption:${ownerDid}:${networkName}`;
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
      privateKey: wallet.privateKey,
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
      ownerDid,
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

    // Sign-in bootstraps the requested owned network through the real create
    // route; a second explicit create is correctly a conflict.
    const descriptor = await alice.getEncryptionNetwork(networkId);
    if (!descriptor) throw new Error("sign-in did not create the network");
    expect(descriptor.networkId).toBe(networkId);
    expect(descriptor.members[0]?.nodeId).toBe(nodeId);

    let decryptEntry: {
      resource: string;
      service: string;
      path: string;
      action: string;
    } | null = null;

    let decryptHttpStatus = 0;
    const transport: DecryptTransport = {
      postDecrypt: async ({ authorization, canonicalBody }) => {
        const response = await fetch(
          `${SERVER_URL}/encryption/networks/${encodeURIComponent(networkId)}/decrypt`,
          { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: canonicalBody },
        );
        decryptHttpStatus = response.status;
        if (!response.ok) throw new Error(`decrypt request failed ${response.status}`);
        return (await response.json()) as DecryptResponseBody;
      },
    };

    const makeService = (activeSession: NonNullable<typeof alice.session>) => new EncryptionService({
      crypto,
      signer: {
        signDecryptInvocation: async (input) => {
          const minted = mintRawNetworkAuthorization(
            activeSession,
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
    const service = makeService(session);

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
    const sessionDid = session.verificationMethod.split("#", 1)[0]!;
    const encodedSecret = session.jwk.d;
    if (typeof encodedSecret !== "string") throw new Error("sign-in session has no Ed25519 key");
    const sessionSecret = Buffer.from(encodedSecret, "base64url");
    const cutoffNow = Math.floor(Date.now() / 1000);
    const cutoff = await signCompactUcanAuthorization({
      issuerDid: sessionDid,
      audienceDid: nodeId,
      attenuation: { [`urn:tinycloud:key:${sessionDid}`]: {
        "tinycloud.key/revoke": [{ version: 1, targetDid: sessionDid, scope: { kind: "global" } }],
      } },
      facts: [{}], proofs: [], notBefore: cutoffNow, expiresAt: cutoffNow + 40,
      nonce: globalThis.crypto.randomUUID(),
      sign: async (bytes) => ed25519.sign(bytes, sessionSecret),
    });
    const keyRevoke = await fetch(`${SERVER_URL}/keys/revoke`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDid: sessionDid, scope: { kind: "global" }, authorization: cutoff.authorization }),
    });
    expect(keyRevoke.status).toBe(200);

    const deniedCreate = await fetch(`${SERVER_URL}/encryption/networks`, {
      method: "POST",
      headers: {
        Authorization: mintRawNetworkAuthorization(session, nodeId, networkId, NETWORK_CREATE_ACTION, createFacts).authorization,
        "Content-Type": "application/json",
      },
      body: canonicalizeEncryptionJson(createBody),
    });
    expect([401, 403]).toContain(deniedCreate.status);
    const deniedDecrypt = await service.decryptEnvelope(
      encryptResult.data,
      { proofs: [session.delegationCid] },
      { descriptor, targetNode: nodeId },
    );
    expect(deniedDecrypt.ok).toBe(false);
    expect([401, 403]).toContain(decryptHttpStatus);
    const revokeFacts = {
      type: NETWORK_ADMIN_TYPE, targetNode: nodeId, networkId,
      bodyHash: canonicalHashHex(crypto.sha256, {}),
      action: "tinycloud.encryption/network.revoke",
    };
    const deniedNetworkRevoke = await fetch(
      `${SERVER_URL}/encryption/networks/${encodeURIComponent(networkId)}/revoke`,
      { method: "POST", headers: { Authorization:
        mintRawNetworkAuthorization(session, nodeId, networkId, revokeFacts.action, revokeFacts).authorization } },
    );
    expect([401, 403]).toContain(deniedNetworkRevoke.status);

    const independent = new TinyCloudNode({
      privateKey: wallet.privateKey,
      host: SERVER_URL,
      prefix: `encryption-independent-${Date.now()}`,
      autoCreateSpace: true,
      manifest,
      includeAccountRegistryPermissions: false,
    });
    await independent.signIn();
    const independentSession = independent.session;
    if (!independentSession) throw new Error("independent sign-in has no session");
    expect(independentSession.verificationMethod.split("#", 1)[0]).not.toBe(sessionDid);
    const liveDecrypt = await makeService(independentSession).decryptEnvelope(
      encryptResult.data,
      { proofs: [independentSession.delegationCid] },
      { descriptor, targetNode: nodeId },
    );
    expect(liveDecrypt.ok).toBe(true);
    if (!liveDecrypt.ok) throw new Error(liveDecrypt.error.message);
    expect(new TextDecoder().decode(liveDecrypt.data)).toBe("tinycloud encryption live test");
    const liveRevoke = await fetch(
      `${SERVER_URL}/encryption/networks/${encodeURIComponent(networkId)}/revoke`,
      { method: "POST", headers: { Authorization:
        mintRawNetworkAuthorization(independentSession, nodeId, networkId, revokeFacts.action, revokeFacts).authorization } },
    );
    expect(liveRevoke.status).toBe(204);
  }, 90_000);
});
