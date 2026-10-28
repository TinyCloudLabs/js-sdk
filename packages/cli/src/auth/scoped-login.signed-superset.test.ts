import { describe, expect, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";
import { keyAbilitiesFor, parseKeysPrefix } from "../lib/named-keys.js";
import { withRecapCaveat } from "./test-support/recap-caveat.js";
import { verifyScopedLogin } from "./scoped-login.js";

const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const otherSigner = new PrivateKeySigner("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "applications");
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const requested: PermissionEntry[] = [
  { service: "tinycloud.kv", space: "applications", path: "example/", actions: ["tinycloud.kv/list"] },
];
const capabilities: PermissionEntry = {
  service: "tinycloud.capabilities", space: "applications", path: "", actions: ["tinycloud.capabilities/read"],
};
const expected = { expectedOwner: ownerDid, purpose: "grant" as const, exactApproval: true };
const openKey = openKeyDelegate({ wasm, signer, sessionKey: key, sessionDid: did });

// Use the existing real owner-signing helper for the consumer's grant.
async function approval(actions = ["tinycloud.kv/list", "tinycloud.kv/get"]) {
  return openKey.delegate(did, { permissions: [capabilities, { ...requested[0]!, actions }] });
}

// Adversarial signed proofs bypass the producer's input guards, not verification.
async function signedProof(options: {
  signer?: PrivateKeySigner;
  space?: string;
  expiresInMs?: number;
  caveat?: Record<string, unknown>;
  rawAbilities?: Record<string, string[]>;
} = {}) {
  const signingKey = options.signer ?? signer;
  const signingAddress = await signingKey.getAddress();
  const signedSpace = wasm.makeSpaceId(signingAddress, 1, options.space ?? "applications");
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "example/": ["tinycloud.kv/list", "tinycloud.kv/get"] } },
    ...(options.rawAbilities ? { rawAbilities: options.rawAbilities } : {}),
    address: signingAddress, chainId: 1, domain: "cli.example.test", spaceId: signedSpace, jwk: key,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + (options.expiresInMs ?? 3600_000)).toISOString(),
  });
  if (options.caveat) prepared.siwe = withRecapCaveat(prepared.siwe, options.caveat);
  const signature = await signingKey.signMessage(prepared.siwe);
  return {
    ...wasm.completeSessionSetup({ ...prepared, signature }),
    address: signingAddress, chainId: 1, spaceId: signedSpace, verificationMethod: did,
    siwe: prepared.siwe, signature,
  };
}

const verify = (data: Record<string, unknown>, permissions = requested) =>
  verifyScopedLogin(data, key, did, permissions, expected);

describe("whole-request owner-signed grants", () => {
  test("accepts requested list plus signed get and retains only verified authority", async () => {
    const proof = await approval();
    const { session } = verify({ ...proof, permissions: requested, ownerDid: did, expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(session.ownerDid).toBe(ownerDid);
    expect(session.permissions).toEqual(expect.arrayContaining([
      { ...requested[0]!, space: spaceId },
      { ...requested[0]!, space: spaceId, actions: ["tinycloud.kv/get"] },
      { ...capabilities, space: spaceId },
    ]));
    expect(session.expiresAt).toBe(proof.siwe!.toString().match(/^Expiration Time: (.+)$/m)![1]);
    expect(session.jwk).toEqual(key);
  });

  test("rejects signed get without requested list despite forged callback scope", async () => {
    const proof = await approval(["tinycloud.kv/get"]);
    expect(() => verify({ ...proof, permissions: requested, permissionsSource: "signed-recap" }))
      .toThrow(expect.objectContaining({ code: "OPENKEY_APPROVAL_NARROWER" }));
  });

  test("rejects a missing requested resource even when another resource has every action", async () => {
    const proof = await approval();
    expect(() => verify(proof, [...requested, { ...requested[0]!, path: "other/" }]))
      .toThrow(expect.objectContaining({ code: "OPENKEY_APPROVAL_NARROWER" }));
  });

  test("a signed action in another service cannot satisfy requested kv/list", async () => {
    const proof = await openKey.delegate(did, { permissions: [capabilities,
      { ...requested[0]!, service: "tinycloud.k", actions: ["tinycloud.k/list"] },
    ] });
    expect(() => verify(proof)).toThrow(expect.objectContaining({ code: "OPENKEY_APPROVAL_NARROWER" }));
  });

  test("rejects invalid signatures and incomplete proof before accepting scope", async () => {
    const proof = await approval();
    for (const invalid of [
      { ...proof, signature: await otherSigner.signMessage(String(proof.siwe)) },
      { ...proof, signature: undefined },
    ]) {
      expect(() => verify(invalid)).toThrow(expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" }));
    }
  });

  test("rejects a proof for another target key or session DID", async () => {
    const proof = await approval();
    const other = wasm.createSessionManager();
    expect(() => verifyScopedLogin(proof, JSON.parse(other.jwk("default")!), did, requested, expected))
      .toThrow(expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" }));
    expect(() => verifyScopedLogin(proof, key, other.getDID("default"), requested, expected))
      .toThrow(expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" }));
  });

  test("rejects another signed owner even when callback owner matches", async () => {
    const proof = await signedProof({ signer: otherSigner });
    expect(() => verify({ ...proof, ownerDid }))
      .toThrow(expect.objectContaining({ code: "OPENKEY_OWNER_MISMATCH" }));
  });

  test("rejects another signed space and a requested full space belonging to another owner", async () => {
    const wrongSpace = await signedProof({ space: "other" });
    expect(() => verify(wrongSpace)).toThrow(expect.objectContaining({ code: "OPENKEY_SCOPE_MISMATCH" }));
    const proof = await approval();
    const otherSpace = wasm.makeSpaceId(await otherSigner.getAddress(), 1, "applications");
    expect(() => verify(proof, [{ ...requested[0]!, space: otherSpace }]))
      .toThrow(expect.objectContaining({ code: "OPENKEY_SCOPE_MISMATCH" }));
  });

  test("rejects expired authority despite a future callback expiry", async () => {
    const proof = await signedProof({ expiresInMs: -30_000 });
    expect(() => verify({ ...proof, expiresAt: "2099-01-01T00:00:00.000Z" }))
      .toThrow(expect.objectContaining({ code: "AUTH_EXPIRED" }));
  });

  test("keeps the requested lifetime cap on a signed superset", async () => {
    const proof = await approval();
    expect(() => verifyScopedLogin(proof, key, did, requested, { ...expected, expiry: { durationMs: 60_000 } }))
      .toThrow(expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED" }));
  });

  test("rejects a requested unrestricted action signed only with a caveat", async () => {
    const proof = await signedProof({ caveat: { tenant: "alpha" } });
    expect(() => verify(proof)).toThrow(expect.objectContaining({ code: "OPENKEY_APPROVAL_NARROWER" }));
  });

  test("rejects signed raw encryption for another owner or an unrequested key folder", async () => {
    for (const resource of [
      `urn:tinycloud:encryption:did:pkh:eip155:1:${await otherSigner.getAddress()}:default`,
      parseKeysPrefix("other/", ownerDid).resource,
    ]) {
      const proof = await signedProof({ rawAbilities: { [resource]: ["tinycloud.encryption/decrypt"] } });
      expect(() => verify(proof)).toThrow(expect.objectContaining({ code: "OPENKEY_SCOPE_MISMATCH" }));
    }
  });

  test("keeps named-key partial-row refusal before whole-request coverage", async () => {
    const namedKeyRow = parseKeysPrefix("qa/", ownerDid);
    const proof = await signedProof({ rawAbilities: { [namedKeyRow.resource]: ["tinycloud.encryption/key.create"] } });
    expect(() => verifyScopedLogin(proof, key, did, requested, { ...expected, namedKeyRow }))
      .toThrow(expect.objectContaining({ code: "KEYS_PARTIAL_GRANT" }));
    const complete = await signedProof({ rawAbilities: keyAbilitiesFor(namedKeyRow) });
    const { session } = verifyScopedLogin(complete, key, did, requested, { ...expected, namedKeyRow });
    expect(session.permissions).toContainEqual({ ...requested[0]!, space: spaceId });
    expect(session.permissions.some((entry) => entry.path === namedKeyRow.resource)).toBe(false);
  });
});
