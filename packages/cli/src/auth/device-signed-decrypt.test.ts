import { afterAll, describe, expect, test } from "bun:test";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";

// TC-3204: device sign-in grants no encryption ability. If OpenKey ever signs decrypt into a device approval that did
// not ask for it, the CLI refuses the approval instead of saving the session.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-signed-decrypt-"));
process.env.TC_HOME = home;
// TC_HOME is read when the profile store loads, so import the CLI modules afterwards.
const { acquireDeviceDelegation } = await import("./device-auth.js");
const { keyToDID } = await import("./local-key.js");
const { sharePublishingPermissions } = await import("../share/publishing-manifest.js");

const NODE = "https://tee.node.tinycloud.xyz";
const SHARE = "https://share.tinycloud.xyz";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "default");
const network = `urn:tinycloud:encryption:${ownerDid}:default`;
const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Record<string, string>;
const sessionDid = keyToDID(key);
// A kv + capabilities/read request with no encryption entry.
const requested = sharePublishingPermissions();

afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

/** OpenKey's side of the relay: WebCrypto ECDH over the JWK the CLI sent. */
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
    version: 1,
    algorithm: "ECDH-P256-A256GCM",
    ephemeralPublicJwk: await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

/** The approved token-endpoint answer for an owner-signed SIWE over `signed`, with `binding` as OpenKey's report. */
async function approval(start: Record<string, unknown>, transactionId: string, signed: PermissionEntry[], binding: PermissionEntry[]) {
  const abilities: Record<string, Record<string, string[]>> = {};
  const rawAbilities: Record<string, string[]> = {};
  for (const permission of signed) {
    if (permission.path.startsWith("urn:tinycloud:encryption:")) {
      rawAbilities[permission.path] = permission.actions;
      continue;
    }
    (abilities[permission.service.slice("tinycloud.".length)] ??= {})[permission.path] = permission.actions;
  }
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities, ...(Object.keys(rawAbilities).length === 0 ? {} : { rawAbilities }), address, chainId: 1, domain: "openkey.so", spaceId, jwk: key,
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const delegation = {
    ...wasm.completeSessionSetup({ ...prepared, signature }),
    jwk: start.publicJwk, verificationMethod: sessionDid, address, chainId: 1, spaceId, ownerDid,
    siwe: prepared.siwe, signature, expiresAt, permissions: binding, hostActivated: true,
  };
  return Response.json({
    status: "approved",
    relay: await encryptRelay(start.relayPublicJwk as object, transactionId, delegation),
    binding: { transactionId, sessionDid, nodeOrigin: NODE, shareOrigin: SHARE, permissions: binding, delegationExpiresAt: expiresAt },
  });
}

/** OpenKey's device API: signs the request plus `signedExtra`; the binding reports `signedExtra` only if `bindingReportsIt`. */
function openKey(signedExtra?: PermissionEntry, bindingReportsIt = false): typeof globalThis.fetch {
  const transactionId = randomBytes(18).toString("base64url");
  let start: Record<string, unknown> | undefined;
  return Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(url).endsWith("/api/device-authorizations")) {
      start = body;
      return Response.json({
        transactionId, userCode: "ABCD-EFGH", verificationUri: "https://openkey.so/device",
        verificationUriComplete: "https://openkey.so/device?user_code=ABCD-EFGH", expiresIn: 600, interval: 2,
      }, { status: 201 });
    }
    const signed = signedExtra ? [...requested, signedExtra] : requested;
    return approval(start!, transactionId, signed, bindingReportsIt ? signed : requested);
  }, { preconnect: () => undefined }) as typeof globalThis.fetch;
}

function acquire(fetchFn: typeof globalThis.fetch) {
  return acquireDeviceDelegation({
    sessionDid, jwk: key, nodeOrigin: NODE, shareOrigin: SHARE, permissions: requested,
    fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
  });
}

const DECRYPT = "tinycloud.encryption/decrypt";
const extras: Array<[string, PermissionEntry]> = [
  ["the owner's default network", { service: "tinycloud.encryption", space: "encryption", path: network, actions: [DECRYPT] }],
  ["share/ files on the default network", { service: "tinycloud.encryption", space: "encryption", path: `${network}/share/abc`, actions: [DECRYPT] }],
  ["decrypt nested inside the owner's space", { service: "tinycloud.encryption", space: spaceId, path: "", actions: [DECRYPT] }],
];

describe("--device refuses an approval in which OpenKey signed decrypt the request did not ask for (TC-3204)", () => {
  for (const bindingReportsIt of [false, true]) {
    test.each(extras)(`refuses decrypt on %s (binding ${bindingReportsIt ? "reports" : "omits"} it)`, async (_name, extra) => {
      await expect(acquire(openKey(extra, bindingReportsIt))).rejects.toMatchObject({
        code: expect.stringMatching(/^(OPENKEY_GRANT_BROADENED|OPENKEY_SCOPE_MISMATCH|DEVICE_AUTH_BINDING_MISMATCH)$/),
      });
    });
  }

  test("accepts the approval when OpenKey signed exactly the request", async () => {
    const result = await acquire(openKey());
    expect(result.approved.some((permission) => permission.service === "tinycloud.encryption")).toBe(false);
  });
});
