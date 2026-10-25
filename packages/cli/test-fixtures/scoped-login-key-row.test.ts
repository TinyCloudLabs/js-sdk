import { describe, expect, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { verifyScopedLogin, verifySignedSession } from "../src/auth/scoped-login.js";
import { withRecapCaveat } from "../src/auth/test-support/recap-caveat.js";
import { keyAbilitiesFor, parseKeysPrefix, type ProfileNamedKeys } from "../src/lib/named-keys.js";
import { CLI_NAME } from "@tinycloud/operations/cli-name";

const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "applications");
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const requested: PermissionEntry[] = [{ service: "tinycloud.kv", space: "applications", path: "example/", actions: ["tinycloud.kv/get"] }];
const CREATE = "tinycloud.encryption/key.create";
const DECRYPT = "tinycloud.encryption/decrypt";
const OTHER = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const qa = parseKeysPrefix("qa/", ownerDid);

/** A real owner-signed session for kv `example/` plus the given raw encryption rows. */
async function proof(rawAbilities: Record<string, string[]>, caveat?: Record<string, unknown>) {
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "example/": ["tinycloud.kv/get"] } },
    ...(Object.keys(rawAbilities).length > 0 ? { rawAbilities } : {}),
    address, chainId: 1, domain: "cli.example.test", spaceId, jwk: key,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + 3600_000).toISOString(),
  });
  const siwe = caveat === undefined ? prepared.siwe : withRecapCaveat(prepared.siwe, caveat, "/qa/");
  const signature = await signer.signMessage(siwe);
  const session = wasm.completeSessionSetup({ ...prepared, siwe, signature });
  return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
    address, chainId: 1, spaceId, ownerDid, siwe, signature };
}

const verify = async (rows: Record<string, string[]>, namedKeyRow?: ProfileNamedKeys) =>
  verifyScopedLogin(await proof(rows), key, did, requested, { expectedOwner: ownerDid, ...(namedKeyRow ? { namedKeyRow } : {}) });

describe("a signed grant carrying the requested named-key folder row", () => {
  test("is accepted, and the row is not part of the approved scope", async () => {
    const { session } = await verify(keyAbilitiesFor(qa), qa);
    const paths = (session.permissions as PermissionEntry[]).map((entry) => entry.path);
    expect(paths).not.toContain(qa.resource);
    expect(paths).toContain("example/");
  });

  test("accepts duplicate identical key actions, and records no key row in approved scope", async () => {
    const signed = await proof({ [qa.resource]: [CREATE, DECRYPT, CREATE, DECRYPT] });
    const keyRows = verifySignedSession(signed, key, did).permissions.filter((entry) => entry.path === qa.resource);
    expect(keyRows.length).toBeGreaterThan(1);
    const { session } = verifyScopedLogin(signed, key, did, requested, { expectedOwner: ownerDid, namedKeyRow: qa });
    expect((session.permissions as PermissionEntry[]).some((entry) => entry.path === qa.resource)).toBe(false);
  });

  test("is accepted with the row unticked (absent)", async () => {
    await verify({}, qa);
  });

  test("is refused when the login did not request it", async () => {
    await expect(verify(keyAbilitiesFor(qa))).rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
  });

  test("is refused when a different folder was requested", async () => {
    await expect(verify(keyAbilitiesFor(qa), parseKeysPrefix("zz", ownerDid))).rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
  });

  test("is refused with an extra ability", async () => {
    await expect(verify({ [qa.resource]: [CREATE, DECRYPT, "tinycloud.encryption/key.read"] }, qa))
      .rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
  });

  test("is refused when the requested folder row has a caveat", async () => {
    const signed = await proof(keyAbilitiesFor(qa), { limit: 1 });
    expect(() => verifyScopedLogin(signed, key, did, requested, { expectedOwner: ownerDid, namedKeyRow: qa }))
      .toThrow(expect.objectContaining({ code: "OPENKEY_SCOPE_MISMATCH" }));
  });

  test.each([[CREATE], [DECRYPT]])("is refused as a partial grant (%s only)", async (only) => {
    await expect(verify({ [qa.resource]: [only!] }, qa)).rejects.toMatchObject({ code: "KEYS_PARTIAL_GRANT" });
  });

  test("is refused for another owner's folder", async () => {
    const other = parseKeysPrefix("qa/", OTHER);
    await expect(verify(keyAbilitiesFor(other), other)).rejects.toMatchObject({
      code: "OPENKEY_SCOPE_MISMATCH",
      message: `The key permission in the approval didn't match what was asked for "<folder>/", so this sign-in wasn't saved. Sign in again with \`${CLI_NAME} auth login --keys <folder>\`.`,
    });
  });

  test("is refused when the requested folder row spells its owner in lowercase", async () => {
    const lowercaseResource = qa.resource.replace(address, address.toLowerCase());
    await expect(verify({ [lowercaseResource]: [CREATE, DECRYPT] }, qa))
      .rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
  });

  test("is refused for another network name", async () => {
    const resource = `urn:tinycloud:encryption:${ownerDid}:other/qa/`;
    await expect(verify({ [resource]: [CREATE, DECRYPT] }, { prefix: "qa", resource }))
      .rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
  });

  test("is refused for an apps/ folder", async () => {
    const resource = `urn:tinycloud:encryption:${ownerDid}:default/apps/x/`;
    await expect(verify({ [resource]: [CREATE, DECRYPT] }, { prefix: "apps/x", resource }))
      .rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
  });

  test("is refused when key.create is on the bare network", async () => {
    const bare = `urn:tinycloud:encryption:${ownerDid}:default`;
    await expect(verify({ [bare]: [CREATE] }, qa)).rejects.toMatchObject({ code: "OPENKEY_GRANT_BROADENED" });
    await expect(verify({ ...keyAbilitiesFor(qa), [bare]: [CREATE] }, qa)).rejects.toMatchObject({ code: "OPENKEY_GRANT_BROADENED" });
  });

  test("is refused when the folder resource has no trailing slash", async () => {
    const resource = `urn:tinycloud:encryption:${ownerDid}:default/qa`;
    await expect(verify({ [resource]: [CREATE, DECRYPT] }, qa)).rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
  });

  test("is refused alongside a second, unrequested folder row", async () => {
    const zz = parseKeysPrefix("zz", ownerDid);
    await expect(verify({ ...keyAbilitiesFor(qa), ...keyAbilitiesFor(zz) }, qa)).rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
  });
});
