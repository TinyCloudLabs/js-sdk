import { afterAll, describe, expect, test } from "bun:test";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";

// A profile approved with only builtin:share-publishing must hold the owner's default-key decrypt,
// which an email-addressed share needs. OpenKey's device API takes it as space `default`, path "".
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-decrypt-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { acquireDeviceDelegation } = await import("./device-auth.js");
const { keyToDID } = await import("./local-key.js");
const { sharePublishingPermissions } = await import("../share/publishing-manifest.js");
const { loadManifestPermissions } = await import("../lib/permissions.js");
const { sessionHoldsEncryptionDecrypt } = await import("../share/adapters.js");

const NODE = "https://tee.node.tinycloud.xyz";
const SHARE = "https://share.tinycloud.xyz";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const network = `urn:tinycloud:encryption:${ownerDid}:default`;
const spaceId = wasm.makeSpaceId(address, 1, "default");
const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Record<string, string>;
const sessionDid = keyToDID(key);
const DECRYPT = "tinycloud.encryption/decrypt";
const requested = sharePublishingPermissions();
const wire: PermissionEntry = { service: "tinycloud.encryption", space: "default", path: "", actions: [DECRYPT] };

afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

async function encryptRelay(relayPublicJwk: object, transactionId: string, value: unknown) {
  const p256 = { name: "ECDH", namedCurve: "P-256" } as const;
  const ephemeral = await crypto.subtle.generateKey(p256, true, ["deriveBits"]);
  const relayPublicKey = await crypto.subtle.importKey("jwk", relayPublicJwk, p256, false, []);
  const sharedSecret = Buffer.from(await crypto.subtle.deriveBits({ name: "ECDH", public: relayPublicKey }, ephemeral.privateKey, 256));
  const extracted = createHmac("sha256", Buffer.from(transactionId)).update(sharedSecret).digest();
  const relayKey = createHmac("sha256", extracted).update(Buffer.from("openkey-device-relay-v1")).update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", relayKey, nonce);
  cipher.setAAD(Buffer.from(transactionId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return {
    version: 1, algorithm: "ECDH-P256-A256GCM",
    ephemeralPublicJwk: await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
    nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"),
  };
}

/** OpenKey as it signs a device request: space entries as KV/capabilities abilities, the decrypt entry as the owner's network (a raw ReCap resource). */
function openKey(report: (signed: PermissionEntry[]) => PermissionEntry[]) {
  const transactionId = randomBytes(18).toString("base64url");
  const startBodies: Record<string, unknown>[] = [];
  const fetchFn = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(url).endsWith("/api/device-authorizations")) {
      startBodies.push(body);
      return Response.json({
        transactionId, userCode: "ABCD-EFGH", verificationUri: "https://openkey.so/device",
        verificationUriComplete: "https://openkey.so/device?user_code=ABCD-EFGH", expiresIn: 600, interval: 2,
      }, { status: 201 });
    }
    const start = startBodies[0]!;
    const asked = start.permissions as PermissionEntry[];
    const abilities: Record<string, Record<string, string[]>> = {};
    const rawAbilities: Record<string, string[]> = {};
    for (const permission of asked) {
      if (permission.service === "tinycloud.encryption") rawAbilities[network] = [DECRYPT];
      else (abilities[permission.service.slice("tinycloud.".length)] ??= {})[permission.path] = permission.actions;
    }
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000).toISOString();
    const prepared = wasm.prepareSession({
      abilities, ...(Object.keys(rawAbilities).length ? { rawAbilities } : {}), address, chainId: 1, domain: "openkey.so", spaceId, jwk: key,
      issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt,
    });
    const signature = await signer.signMessage(prepared.siwe);
    const delegation = {
      ...wasm.completeSessionSetup({ ...prepared, signature }),
      jwk: start.publicJwk, verificationMethod: sessionDid, address, chainId: 1, spaceId, ownerDid,
      siwe: prepared.siwe, signature, expiresAt, permissions: report(asked), hostActivated: true,
    };
    return Response.json({
      status: "approved",
      relay: await encryptRelay(start.relayPublicJwk as object, transactionId, delegation),
      binding: { transactionId, sessionDid, nodeOrigin: NODE, shareOrigin: SHARE, permissions: report(asked), delegationExpiresAt: expiresAt },
    });
  }, { preconnect: () => undefined }) as typeof globalThis.fetch;
  return { fetchFn, startBodies };
}

const acquire = (stub: { fetchFn: typeof globalThis.fetch }, permissions: PermissionEntry[] = requested) =>
  acquireDeviceDelegation({
    sessionDid, jwk: key, nodeOrigin: NODE, shareOrigin: SHARE, permissions,
    fetchFn: stub.fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
  });

describe("share publishing holds the owner's default-key decrypt", () => {
  test("the manifest requests the device decrypt entry, resolved as space default with an empty path, through both login paths", async () => {
    expect(requested).toContainEqual(wire);
    expect(requested.filter((permission) => permission.service === "tinycloud.encryption")).toEqual([wire]);
    await ProfileManager.setKey("default", key);
    await ProfileManager.setProfile("default", { name: "default", host: NODE, chainId: 1, spaceName: "default", did: sessionDid, createdAt: "2026-10-01T00:00:00.000Z" });
    const loaded = await loadManifestPermissions("builtin:share-publishing", "default", { allowLogicalSpaces: true, device: true });
    expect(loaded).toContainEqual(wire);
  });

  test("a device approval of only that manifest holds decrypt on the owner's default network, which lets an addressed share past decrypt-not-held", async () => {
    // OpenKey reports the entry as it was asked (the wire shape) in one place and as the signed network in the other.
    const stub = openKey((asked) => asked.map((permission) => permission.service === "tinycloud.encryption"
      ? { service: "tinycloud.encryption", space: "encryption", path: network, actions: [DECRYPT] }
      : permission));
    const result = await acquire(stub);
    expect(stub.startBodies[0]!.permissions).toContainEqual(wire);
    expect(result.declined).toEqual([]);
    // Tuples compare with the owner's address lowercased.
    expect(result.approved).toContainEqual({ service: "tinycloud.encryption", space: "encryption", path: network.toLowerCase(), actions: [DECRYPT] });
    // The check `share publish --to email:` makes before any upload.
    expect(sessionHoldsEncryptionDecrypt({
      hasRuntimePermissions: (needed) => needed.every((entry) => result.session.permissions.some((held: PermissionEntry) =>
        held.service === entry.service && held.path.toLowerCase() === entry.path.toLowerCase() &&
        entry.actions.every((action) => held.actions.includes(action)))),
    }, network)).toBe(true);
  });

  test("an approval that reports the entry in the requested shape is accepted the same way", async () => {
    const result = await acquire(openKey((asked) => asked));
    expect(result.declined).toEqual([]);
  });

  test("device sign-in still refuses every other encryption entry before contacting OpenKey", async () => {
    const other: PermissionEntry[][] = [
      [...requested, { service: "tinycloud.encryption", space: "encryption", path: network, actions: [DECRYPT] }],
      [...requested, { ...wire, space: "applications" }],
      [...requested, { ...wire, path: "keys/" }],
      [...requested, { ...wire, actions: ["tinycloud.encryption/key.create"] }],
      [...requested, { ...wire, actions: [DECRYPT, "tinycloud.encryption/key.create"] }],
    ];
    for (const permissions of other) {
      const stub = openKey((asked) => asked);
      await expect(acquire(stub, permissions)).rejects.toMatchObject({ exitCode: 2 });
      expect(stub.startBodies).toEqual([]);
    }
  });
});
