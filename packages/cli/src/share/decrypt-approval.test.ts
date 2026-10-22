import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createCipheriv, createHmac, randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode, type PermissionEntry } from "@tinycloud/node-sdk";
import { tinycloudHomePath } from "@tinycloud/operations/state";

// The profile store resolves TC_HOME when it is first used, so set it before importing the modules.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-decrypt-approval-"));
process.env.TC_HOME = home;
if (!tinycloudHomePath().startsWith(home)) {
  throw new Error(`Refusing to write profiles outside the temp home: ${tinycloudHomePath()}`);
}
const { ProfileManager } = await import("../config/profiles.js");
const { DEFAULT_SHARE_ORIGIN } = await import("../config/constants.js");
const { loadAdditionalDelegations } = await import("../lib/permissions.js");
const { keyToDID } = await import("../auth/local-key.js");
const { approveShareDecrypt, DECRYPT_APPROVAL_TTL_SECONDS } = await import("./decrypt-approval.js");

const NODE = "https://tee.node.tinycloud.xyz";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "default");
const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Record<string, string>;
const sessionDid = keyToDID(key);
const networkUrn = `urn:tinycloud:encryption:${ownerDid}:default`;
// The short entry the CLI sends to OpenKey, and the owner-signed raw entry OpenKey returns for it.
const requested: PermissionEntry[] = [{ service: "tinycloud.encryption", space: "default", path: "", actions: ["tinycloud.encryption/decrypt"] }];
const signedRaw: PermissionEntry[] = [{ service: "tinycloud.encryption", space: "encryption", path: networkUrn, actions: ["tinycloud.encryption/decrypt"] }];

/** OpenKey's side of the relay, independently of the CLI's implementation. */
async function encryptRelay(relayPublicJwk: object, transactionId: string, value: unknown) {
  const p256 = { name: "ECDH", namedCurve: "P-256" } as const;
  const ephemeral = await webcrypto.subtle.generateKey(p256, true, ["deriveBits"]);
  const receiver = await webcrypto.subtle.importKey("jwk", relayPublicJwk, p256, false, []);
  const sharedSecret = Buffer.from(await webcrypto.subtle.deriveBits({ name: "ECDH", public: receiver }, ephemeral.privateKey, 256));
  const extracted = createHmac("sha256", Buffer.from(transactionId)).update(sharedSecret).digest();
  const relayKey = createHmac("sha256", extracted).update(Buffer.from("openkey-device-relay-v1")).update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", relayKey, nonce);
  cipher.setAAD(Buffer.from(transactionId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return {
    version: 1,
    algorithm: "ECDH-P256-A256GCM",
    ephemeralPublicJwk: await webcrypto.subtle.exportKey("jwk", ephemeral.publicKey),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

/** OpenKey's device API for a decrypt-only request: it approves with an owner-signed raw decrypt ReCap. */
async function openKeyApprovingDecryptOnly() {
  const transactionId = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + DECRYPT_APPROVAL_TTL_SECONDS * 1000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: {},
    rawAbilities: { [networkUrn]: ["tinycloud.encryption/decrypt"] },
    address, chainId: 1, domain: "openkey.so", spaceId, jwk: key,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expirationTime: expiresAt,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const completed = wasm.completeSessionSetup({ ...prepared, signature });
  const requests: string[] = [];
  const starts: Record<string, unknown>[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === `${NODE}/delegate`) return Response.json({ activated: [], skipped: [] });
    requests.push(String(url));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(url).endsWith("/api/device-authorizations")) {
      starts.push(body);
      return Response.json({
        transactionId,
        userCode: "ABCD-EFGH",
        verificationUri: "https://openkey.so/device",
        verificationUriComplete: "https://openkey.so/device?user_code=ABCD-EFGH",
        expiresIn: 600,
        interval: 1,
      }, { status: 201 });
    }
    const start = starts[0]!;
    const relayed = {
      ...completed, jwk: start.publicJwk, verificationMethod: sessionDid, address, chainId: 1, spaceId, ownerDid,
      siwe: prepared.siwe, signature, expiresAt, hostActivated: true, permissions: signedRaw,
    };
    return Response.json({
      status: "approved",
      relay: await encryptRelay(start.relayPublicJwk as object, transactionId, relayed),
      binding: { transactionId, sessionDid, nodeOrigin: NODE, shareOrigin: DEFAULT_SHARE_ORIGIN, permissions: requested, delegationExpiresAt: expiresAt },
    });
  };
  return { fetchFn, requests, starts, delegationCid: completed.delegationCid };
}

/**
 * A real node restored from the profile's base session, as the publish path holds it.
 * Only the base session (kv and capabilities) is restored; decrypt is what the approval adds.
 */
async function restoredBaseNode(): Promise<TinyCloudNode> {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: { capabilities: { "": ["tinycloud.capabilities/read"] } },
    address, chainId: 1, domain: "openkey.so", spaceId, jwk: key,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expirationTime: expiresAt,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const completed = wasm.completeSessionSetup({ ...prepared, signature });
  const node = new TinyCloudNode({ host: NODE });
  await node.restoreSession({
    delegationHeader: completed.delegationHeader as { Authorization: string },
    delegationCid: completed.delegationCid,
    spaceId,
    jwk: key,
    verificationMethod: sessionDid,
    address,
    chainId: 1,
    siwe: prepared.siwe,
    signature,
    expiresAt,
    tinycloudHosts: [NODE],
  });
  return node;
}

beforeEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
  await ProfileManager.setProfile("test", { name: "test", host: NODE, chainId: 1, spaceName: "default", ownerDid, did: ownerDid, sessionDid, createdAt: "2026-10-01T00:00:00.000Z" } as never);
  await ProfileManager.setKey("test", key);
});

afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

describe("share decrypt approval against the OpenKey relay", () => {
  it("verifies the owner-signed decrypt approval and stores it on the profile", async () => {
    const openkey = await openKeyApprovingDecryptOnly();
    const node = await restoredBaseNode();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(openkey.fetchFn as typeof fetch);
    try {
      await approveShareDecrypt({ profileName: "test", node });
    } finally {
      fetchSpy.mockRestore();
    }
    expect(openkey.requests).toHaveLength(2);
    expect(openkey.starts[0]!.permissions).toEqual(requested);
    expect(openkey.starts[0]!.delegationTtlSeconds).toBe(3540);
    const stored = await loadAdditionalDelegations("test");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.delegation.cid).toBe(openkey.delegationCid);
    expect(stored[0]!.permissions).toContainEqual(signedRaw[0]);
  });
});
