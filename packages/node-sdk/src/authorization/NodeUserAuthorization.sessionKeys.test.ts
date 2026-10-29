import { expect, setSystemTime, spyOn, test } from "bun:test";
import type { ISessionManager, IWasmBindings, TinyCloudSession } from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

const ADDRESS = "0x0000000000000000000000000000000000000001";

// Follow the strict in-process manager in TinyCloudNode.signInManifest.test.ts:
// missing keys stay missing and rename moves, rather than recreates, a key.
// Distinct serials model key identity without generating cryptographic keys.
function sessionManager(): ISessionManager {
  let serial = 0;
  const keys = new Map<string, string>();
  const manager: ISessionManager = {
    createSessionKey(id) {
      keys.set(id, JSON.stringify({ kty: "fixture", material: ++serial }));
      return manager.getDID(id);
    },
    renameSessionKeyId(oldId, newId) {
      const key = keys.get(oldId);
      if (key === undefined) throw new Error(`Unknown fixture key: ${oldId}`);
      keys.delete(oldId);
      keys.set(newId, key);
    },
    jwk(id) {
      return keys.get(id);
    },
    getDID(id) {
      const key = keys.get(id);
      if (key === undefined) throw new Error(`Unknown fixture key: ${id}`);
      return `did:key:fixture-${JSON.parse(key).material}`;
    },
  };
  manager.createSessionKey("default");
  return manager;
}

function bindings(manager: ISessionManager): IWasmBindings {
  const unsupported = (): never => { throw new Error("Outside the session-key fixture"); };
  return {
    invoke: unsupported,
    prepareSession: (params: Record<string, unknown>) => ({
      siwe: `Fixture only\nIssued At: ${params.issuedAt}\nExpiration Time: ${params.expirationTime}`,
      jwk: params.jwk,
      spaceId: params.spaceId,
      verificationMethod: "did:key:fixture",
    }),
    // Opaque fixture handles only: no signature or authority verification claim.
    completeSessionSetup: () => ({
      delegationHeader: { Authorization: "fixture-not-authority" },
      delegationCid: "fixture-not-a-cid",
    }),
    ensureEip55: (address) => address,
    makeSpaceId: (address, chainId, prefix) => `tinycloud:pkh:eip155:${chainId}:${address}:${prefix}`,
    createDelegation: unsupported,
    generateHostSIWEMessage: unsupported,
    siweToDelegationHeaders: unsupported,
    protocolVersion: unsupported,
    vault_encrypt: unsupported,
    vault_decrypt: unsupported,
    vault_derive_key: unsupported,
    vault_x25519_from_seed: unsupported,
    vault_x25519_dh: unsupported,
    vault_random_bytes: unsupported,
    vault_sha256: unsupported,
    createSessionManager: () => manager,
  };
}

test("same-clock sign-ins preserve independent session bindings and earlier/default keys", async () => {
  const manager = sessionManager();
  const defaultKey = manager.jwk("default");
  const defaultDid = manager.getDID("default");
  const storage = new MemorySessionStorage();
  const auth = new NodeUserAuthorization({
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => 1,
      signMessage: async () => "fixture-not-a-signature",
    },
    wasmBindings: bindings(manager),
    sessionManager: manager,
    sessionStorage: storage,
    domain: "fixture.invalid",
    tinycloudHosts: ["https://fixture.invalid"],
    signStrategy: { type: "auto-sign" },
    includeAccountRegistryPermissions: false,
  });
  // External host/activation boundaries are outside this key-lifecycle test.
  auth.refreshNodeInfo = async () => {};
  auth.ensureSpaceExists = async () => {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network is outside the session-key fixture"); };
  setSystemTime(new Date("2026-10-29T00:00:00.000Z"));
  const random = spyOn(Math, "random").mockReturnValueOnce(0.125).mockReturnValueOnce(0.25).mockReturnValueOnce(0.5);
  try {
    const sessions: TinyCloudSession[] = [];
    for (let index = 0; index < 3; index++) {
      const client = await auth.signIn();
      const session = auth.tinyCloudSession!;
      expect(client.sessionKey).toBe(session.sessionKey);
      sessions.push(structuredClone(session));
    }

    expect(new Set(sessions.map((session) => session.sessionKey)).size).toBe(3);
    expect(new Set(sessions.map((session) => JSON.stringify(session.jwk))).size).toBe(3);
    for (const session of sessions) {
      expect(manager.jwk(session.sessionKey)).toBe(JSON.stringify(session.jwk));
      expect(manager.getDID(session.sessionKey)).toBe(session.verificationMethod);
    }
    expect(manager.jwk("default")).toBe(defaultKey);
    expect(manager.getDID("default")).toBe(defaultDid);
    const saved = await storage.load(ADDRESS);
    expect(saved?.sessionKey).toBe(manager.jwk(sessions[2]!.sessionKey));
    expect(saved?.tinycloudSession.verificationMethod).toBe(sessions[2]!.verificationMethod);
  } finally {
    random.mockRestore();
    setSystemTime();
    globalThis.fetch = originalFetch;
  }
});
