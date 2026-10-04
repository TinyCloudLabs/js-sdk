import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { openKeyDelegate, type OpenKeyCallback, type OpenKeyDelegate } from "../test-support/openkey-delegate.js";

const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-portable-proof-"));
process.env.TC_HOME = home;
const recordedErrors: unknown[] = [];
type SignedCallback = OpenKeyCallback;
let callback: SignedCallback;
const staticCallback: OpenKeyDelegate = async () => callback;
let acquire: OpenKeyDelegate = staticCallback;
let activationError: Error | undefined;
const activated: unknown[] = [];
const node = {
  hasRuntimePermissions: () => false,
  useRuntimeDelegation: async (delegation: unknown) => {
    if (activationError) throw activationError;
    activated.push(delegation);
  },
};
mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => node,
  bootstrapDelegatedSession: async () => node,
}));
mock.module("../auth/browser-auth.js", () => ({
  startAuthFlow: async (did: string, options: { permissions?: PermissionEntry[] }) => acquire(did, options),
  publicJwkForDelegation: (jwk: Record<string, unknown>) => {
    const { d: _privateKey, ...publicKey } = jwk;
    return publicKey;
  },
  validateDelegationCallbackPayload: () => null,
}));
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(public code: string, message: string, public exitCode: number, public metadata?: Record<string, unknown>) {
      super(message);
    }
  },
  cliErrorFromService: (error: { code: string; message: string; meta?: Record<string, unknown> }) =>
    Object.assign(new Error(error.message), { code: error.code, exitCode: 1, metadata: error.meta }),
  handleError: (error: unknown) => { recordedErrors.push(error); },
  setActiveProfileName: () => {},
}));
mock.module("../output/formatter.js", () => ({
  isInteractive: () => false,
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, action: () => Promise<unknown>) => action(),
  outputJson: () => {},
  formatField: (label: string, value: unknown) => `${label}: ${value}`,
  formatTable: () => "",
}));

const { ProfileManager } = await import("../config/profiles.js");
const { additionalDelegationsPath, writeJsonAtomic } = await import("@tinycloud/operations/state");
const { loadAdditionalDelegations, readGrantHistory } = await import("../lib/permissions.js");
const { ensureDelegationAuthority, portableFromOpenKeyDelegation, registerAuthCommand } = await import("./auth.js");
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "secrets");
const network = `urn:tinycloud:encryption:${ownerDid}:default`;
const extraNetwork = `urn:tinycloud:encryption:${ownerDid}:other`;
const manager = wasm.createSessionManager();
const jwk = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const host = "https://node.example.test";
const requested: PermissionEntry[] = [
  { service: "tinycloud.kv", space: spaceId, path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] },
  { service: "tinycloud.encryption", space: "encryption", path: network, actions: ["tinycloud.encryption/decrypt"] },
];

async function signedProof(options: { nested?: boolean; broad?: boolean; raw?: boolean; rawNetwork?: string } = {}): Promise<SignedCallback> {
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: {
      kv: {
        "vault/secrets/KEY": ["tinycloud.kv/get"],
        ...(options.broad ? { "vault/secrets/EXTRA": ["tinycloud.kv/get"] } : {}),
      },
      ...(options.nested ? { encryption: { [network]: ["tinycloud.encryption/decrypt"] } } : {}),
    },
    ...(options.nested || options.raw === false ? {} : { rawAbilities: {
      [options.rawNetwork ?? network]: ["tinycloud.encryption/decrypt"],
      ...(options.broad ? { [extraNetwork]: ["tinycloud.encryption/decrypt"] } : {}),
    } }),
    address, chainId: 1, domain: "cli.example.test", spaceId, jwk,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + 3600_000).toISOString(),
  });
  const signature = await signer.signMessage(prepared.siwe);
  const result = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    ...result, address, chainId: 1, spaceId, verificationMethod: did,
    siwe: prepared.siwe, signature,
    // Deliberately omit or understate unsigned metadata; the signed ReCap alone must decide authority.
    permissions: requested,
  };
}

const openKey = openKeyDelegate({ wasm, signer, sessionKey: jwk, sessionDid: did });
const openKeyRequests = openKey.requests;

let profileName: string;
let profileNumber = 0;

beforeEach(async () => {
  recordedErrors.length = 0;
  activated.length = 0;
  activationError = undefined;
  acquire = staticCallback;
  openKeyRequests.length = 0;
  profileName = `portable-${++profileNumber}`;
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setConfig({ defaultProfile: profileName, version: 1 });
  await ProfileManager.setKey(profileName, jwk);
  await ProfileManager.setProfile(profileName, {
    name: profileName, host, did, sessionDid: did, ownerDid, chainId: 1,
    spaceName: "secrets", spaceId, authMethod: "openkey", posture: "owner-openkey",
    operatorType: "human", createdAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

async function escalate(proof: SignedCallback, expectedOwner = ownerDid, expiryOption?: string): Promise<void> {
  callback = proof;
  const profile = await ProfileManager.getProfile(profileName);
  if (expectedOwner !== ownerDid) {
    await ProfileManager.setProfile(profileName, { ...profile, ownerDid: expectedOwner });
  }
  await ensureDelegationAuthority({
    ctx: { profile: profileName, host },
    profile: await ProfileManager.getProfile(profileName),
    node: node as never,
    requested, expiryOption, reason: "Read named secret", yes: true,
    openKeyAcquisition: async () => callback,
  });
}

describe("signed portable OpenKey grants", () => {
  test("rejects space-nested decrypt even when callback claims raw decrypt", async () => {
    await expect(escalate(await signedProof({ nested: true, raw: false }))).rejects.toMatchObject({
      code: "OPENKEY_GRANT_BROADENED", message: expect.stringContaining("too old"),
    });
    expect(activated).toEqual([]);
    expect(await loadAdditionalDelegations(profileName)).toEqual([]);
  });

  test("rejects broader signed KV and network authority hidden by callback permissions", async () => {
    await expect(escalate(await signedProof({ broad: true }))).rejects.toMatchObject({
      code: "OPENKEY_GRANT_BROADENED",
      message: expect.stringContaining("beyond the requested grant. No grant was stored."),
    });
    expect(activated).toEqual([]);
    expect(await loadAdditionalDelegations(profileName)).toEqual([]);
  });

  test("rejects a signed owner other than the pinned profile owner", async () => {
    await expect(escalate(await signedProof(), "did:pkh:eip155:1:0x1111111111111111111111111111111111111111"))
      .rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
    expect(await loadAdditionalDelegations(profileName)).toEqual([]);
  });

  test("binds signed grant to the stored session key and DID", async () => {
    const proof = await signedProof();
    const other = wasm.createSessionManager();
    await ProfileManager.setKey(profileName, JSON.parse(other.jwk("default")!));
    await expect(escalate(proof)).rejects.toMatchObject({ code: "OPENKEY_PROOF_INVALID" });
    await ProfileManager.setKey(profileName, jwk);
    await ProfileManager.setProfile(profileName, {
      ...await ProfileManager.getProfile(profileName), sessionDid: other.getDID("default"),
    });
    await expect(escalate(proof)).rejects.toMatchObject({ code: "OPENKEY_PROOF_INVALID" });
    expect(activated).toEqual([]);
    expect(await loadAdditionalDelegations(profileName)).toEqual([]);
  });

  test("rejects missing proof and a signed expiry beyond the requested lifetime", async () => {
    const proof = await signedProof();
    await expect(escalate({ ...proof, siwe: undefined })).rejects.toMatchObject({ code: "OPENKEY_PROOF_INVALID" });
    await expect(escalate(proof, ownerDid, "1m")).rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
    expect(await loadAdditionalDelegations(profileName)).toEqual([]);
  });

  test("activation refusal leaves stored delegations unchanged", async () => {
    activationError = new Error("activation refused");
    await expect(escalate(await signedProof())).rejects.toThrow("activation refused");
    expect(await loadAdditionalDelegations(profileName)).toEqual([]);
    expect(await readGrantHistory(profileName)).toEqual([]);
  });

  test("a second group's rejected proof leaves the first group's grant unstored", async () => {
    callback = await signedProof();
    const otherSpace: PermissionEntry = {
      service: "tinycloud.kv", space: "applications", path: "example/", actions: ["tinycloud.kv/get"],
    };
    await expect(ensureDelegationAuthority({
      ctx: { profile: profileName, host },
      profile: await ProfileManager.getProfile(profileName),
      node: node as never,
      requested: [...requested, otherSpace],
      expiryOption: undefined, reason: "Read secret and application", yes: true,
      openKeyAcquisition: async () => callback,
    })).rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
    expect(await loadAdditionalDelegations(profileName)).toEqual([]);
  });

  test("accepts a signed raw plus KV grant and persists exactly its authority", async () => {
    const proof = await signedProof();
    await escalate(proof);
    const stored = await loadAdditionalDelegations(profileName);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.permissions).toEqual(expect.arrayContaining(requested));
    expect(stored[0]!.delegation.resources).toContainEqual({
      service: "encryption", space: "encryption", path: network, actions: ["tinycloud.encryption/decrypt"],
    });
    expect(activated).toHaveLength(1);
    expect((await readGrantHistory(profileName))[0]?.addedCaps).toEqual(expect.arrayContaining(requested));
  });

  test("a grant never replaces a stored record for the same CID that carries a request binding", async () => {
    const proof = await signedProof();
    const bound = {
      delegation: {
        cid: proof.delegationCid,
        delegationHeader: proof.delegationHeader,
        expiry: new Date(Date.now() + 3_600_000).toISOString(),
        siweProof: { siwe: proof.siwe, signature: proof.signature },
      },
      permissions: requested,
      authorityRequest: { requestId: "req_bound", requested },
    };
    await writeJsonAtomic(additionalDelegationsPath(profileName), [bound]);

    await escalate(proof);

    expect(activated).toHaveLength(1);
    expect(await loadAdditionalDelegations(profileName) as unknown[]).toEqual([bound]);
  });

  test("resolves a logical requested space to the signed space and refuses another space", async () => {
    const proof = await signedProof();
    const verification = { key: jwk, sessionDid: did, expectedOwner: ownerDid };
    const logical = [{ ...requested[0]!, space: "secrets" }, requested[1]!];
    const portable = portableFromOpenKeyDelegation(proof, logical, host, verification);
    expect(portable.resources).toContainEqual({
      service: "kv", space: spaceId, path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"],
    });
    expect(() => portableFromOpenKeyDelegation(proof,
      [{ ...requested[0]!, space: "applications" }, requested[1]!], host, verification))
      .toThrow(expect.objectContaining({ code: "OPENKEY_SCOPE_MISMATCH" }));
  });

  test("matches the owner address without folding the grant space name", async () => {
    const proof = await signedProof();
    const verification = { key: jwk, sessionDid: did, expectedOwner: ownerDid };
    const lowercaseAddress = spaceId.replace(address, address.toLowerCase());
    expect(portableFromOpenKeyDelegation(proof,
      [{ ...requested[0]!, space: lowercaseAddress }, requested[1]!], host, verification).spaceId).toBe(spaceId);

    const differentlyCasedName = `${spaceId.slice(0, -"secrets".length)}Secrets`;
    expect(() => portableFromOpenKeyDelegation(proof,
      [{ ...requested[0]!, space: differentlyCasedName }, requested[1]!], host, verification))
      .toThrow(expect.objectContaining({
        code: "OPENKEY_SCOPE_MISMATCH",
        message: expect.stringContaining("No grant was stored."),
      }));
  });

  test("refuses a signed raw network not owned by the signer", async () => {
    const foreign = "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
    const proof = await signedProof({ rawNetwork: foreign });
    expect(() => portableFromOpenKeyDelegation(proof,
      [requested[0]!, { ...requested[1]!, path: foreign }], host,
      { key: jwk, sessionDid: did, expectedOwner: ownerDid }))
      .toThrow(expect.objectContaining({ code: "OPENKEY_SCOPE_MISMATCH" }));
  });

  test("auth request grant path also refuses unsigned under-reporting before storage", async () => {
    callback = { ...await signedProof({ broad: true }), permissions: [requested[0]] };
    const program = new Command();
    program.option("-p, --profile <name>");
    registerAuthCommand(program);
    await program.parseAsync(["node", "tc", "--profile", profileName, "auth", "request", "--grant",
      "--cap", "tinycloud.kv:secrets:vault/secrets/KEY:get"], { from: "node" });
    expect(recordedErrors).toEqual([expect.objectContaining({
      code: "OPENKEY_GRANT_BROADENED",
      message: expect.stringContaining("beyond the requested grant. No grant was stored."),
    })]);
    expect(activated).toEqual([]);
    expect(await loadAdditionalDelegations(profileName)).toEqual([]);
  });

  test("auth request grant path stores the real signed effective scope", async () => {
    callback = { ...await signedProof({ raw: false }), permissions: [] };
    const program = new Command();
    program.option("-p, --profile <name>");
    registerAuthCommand(program);
    await program.parseAsync(["node", "tc", "--profile", profileName, "auth", "request", "--grant",
      "--cap", "tinycloud.kv:secrets:vault/secrets/KEY:get"], { from: "node" });
    expect(recordedErrors).toEqual([]);
    expect(activated).toHaveLength(1);
    const stored = await loadAdditionalDelegations(profileName);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.permissions).toEqual([requested[0]]);
    expect(stored[0]!.delegation.resources).toContainEqual({
      service: "kv", space: spaceId, path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"],
    });
  });

  test("auth request activation failure leaves no stored grant or history", async () => {
    callback = { ...await signedProof({ raw: false }), permissions: [requested[0]] };
    activationError = new Error("activation refused");
    const program = new Command();
    program.option("-p, --profile <name>");
    registerAuthCommand(program);
    await program.parseAsync(["node", "tc", "--profile", profileName, "auth", "request", "--grant",
      "--cap", "tinycloud.kv:secrets:vault/secrets/KEY:get"], { from: "node" });
    expect(recordedErrors).toEqual([activationError]);
    expect(await loadAdditionalDelegations(profileName)).toEqual([]);
    expect(await readGrantHistory(profileName)).toEqual([]);
  });

  test("a missing read and decrypt escalate as a request OpenKey signs; its capabilities/read is requested authority", async () => {
    // The canonical `secrets get` missing set: KV in the owner space URI, raw decrypt without a space.
    const missing = [requested[0]!, { service: "tinycloud.encryption", path: network, actions: ["tinycloud.encryption/decrypt"] } as PermissionEntry];
    await ensureDelegationAuthority({
      ctx: { profile: profileName, host },
      profile: await ProfileManager.getProfile(profileName),
      node: node as never,
      requested: missing, expiryOption: undefined, reason: "Read named secret", yes: true, force: true,
      anchorSpace: "secrets",
      openKeyAcquisition: openKey.delegate,
    });
    expect(openKeyRequests).toEqual([[
      { service: "tinycloud.capabilities", space: spaceId, path: "", actions: ["tinycloud.capabilities/read"] },
      requested[0],
      { service: "tinycloud.encryption", space: "encryption", path: network, actions: ["tinycloud.encryption/decrypt"] },
    ]]);
    const stored = await loadAdditionalDelegations(profileName);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.delegation.path).toBe("vault/secrets/KEY");
    expect(stored[0]!.permissions).toEqual(expect.arrayContaining([
      ...requested,
      { service: "tinycloud.capabilities", space: spaceId, path: "", actions: ["tinycloud.capabilities/read"] },
    ]));
    expect(activated).toHaveLength(1);
  });

  test("a decrypt-only escalation is anchored on the secrets space so OpenKey can sign it", async () => {
    await ensureDelegationAuthority({
      ctx: { profile: profileName, host },
      profile: { ...await ProfileManager.getProfile(profileName), spaceName: "default", spaceId: undefined },
      node: node as never,
      requested: [{ service: "tinycloud.encryption", path: network, actions: ["tinycloud.encryption/decrypt"] } as PermissionEntry],
      expiryOption: undefined, reason: "Decrypt named secret", yes: true, force: true,
      anchorSpace: "secrets",
      openKeyAcquisition: openKey.delegate,
    });
    expect(openKeyRequests).toEqual([[
      { service: "tinycloud.capabilities", space: "secrets", path: "", actions: ["tinycloud.capabilities/read"] },
      { service: "tinycloud.encryption", space: "encryption", path: network, actions: ["tinycloud.encryption/decrypt"] },
    ]]);
    const stored = await loadAdditionalDelegations(profileName);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.delegation.spaceId).toBe(spaceId);
    expect(stored[0]!.delegation.resources).toContainEqual({
      service: "encryption", space: "encryption", path: network, actions: ["tinycloud.encryption/decrypt"],
    });
    expect(activated).toHaveLength(1);
  });

  test("auth request --grant sends OpenKey the capabilities/read it requires and stores the signed grant", async () => {
    acquire = openKey.delegate;
    const program = new Command();
    program.option("-p, --profile <name>");
    registerAuthCommand(program);
    await program.parseAsync(["node", "tc", "--profile", profileName, "auth", "request", "--grant",
      "--cap", "tinycloud.kv:secrets:vault/secrets/KEY:get"], { from: "node" });
    expect(recordedErrors).toEqual([]);
    expect(openKeyRequests[0]).toContainEqual({
      service: "tinycloud.capabilities", space: spaceId.toLowerCase(), path: "", actions: ["tinycloud.capabilities/read"],
    });
    expect(activated).toHaveLength(1);
    expect(await loadAdditionalDelegations(profileName)).toHaveLength(1);
  });
});
