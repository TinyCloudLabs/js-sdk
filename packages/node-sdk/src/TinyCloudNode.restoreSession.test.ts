import { describe, expect, test } from "bun:test";

import { principalDidEquals, type ISessionManager, type IWasmBindings } from "@tinycloud/sdk-core";

import { activateValidatedRuntimeDelegation } from "./delegation";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

const RESTORE_HOST = "http://127.0.0.1:1";

function restorableData(jwk: object, verificationMethod: string) {
  return {
    delegationHeader: { Authorization: "Bearer restore-test" },
    delegationCid: "bafy-restore-test",
    spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
    jwk,
    verificationMethod,
  };
}

function withSiweExpiration(siwe: string, expiresAt: Date): string {
  const updated = siwe.replace(
    /^Expiration Time: .+$/m,
    `Expiration Time: ${expiresAt.toISOString()}`,
  );
  if (updated === siwe) throw new Error("test SIWE did not contain an expiration time");
  return updated;
}

function legacySessionManager(): ISessionManager {
  return {
    createSessionKey: (id) => id,
    renameSessionKeyId: () => undefined,
    getDID: (id) => `did:key:${id}#${id}`,
    jwk: () => JSON.stringify({
      kty: "OKP", crv: "Ed25519",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      d: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
  };
}

function legacyBindings(): IWasmBindings {
  return { createSessionManager: legacySessionManager } as IWasmBindings;
}

describe("TinyCloudNode.restoreSession session-key lifecycle", () => {
  test("keeps the live key, auth, host, service graph, and grants after every rejected restore", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const restored = new TinyCloudNode({ wasmBindings: new NodeWasmBindings() });
      await restored.restoreSession(fixture.restorableSession);
      const delegation = await fixture.mintDelegation();
      const activated = await activateValidatedRuntimeDelegation(restored, delegation, { host: fixture.host });
      await fixture.readAndDecrypt(restored, activated);
      const sourceJwk = fixture.restorableSession.jwk as Record<string, string>;
      const sourceDid = fixture.restorableSession.verificationMethod;
      const unrelatedDid = new NodeWasmBindings().createSessionManager().getDID("default");
      const publicOnly = { ...sourceJwk };
      delete publicOnly.d;
      const previous = {
        did: restored.sessionDid,
        host: restored.hosts[0],
        manager: (restored as any).sessionManager,
        serviceContext: (restored as any)._serviceContext,
        kv: (restored as any)._kv,
        auth: (restored as any).auth,
        grants: (restored as any).runtimePermissionGrants,
      };
      const assertPriorState = async () => {
        expect(restored.sessionDid).toBe(previous.did);
        expect(restored.hosts[0]).toBe(previous.host);
        expect((restored as any).sessionManager).toBe(previous.manager);
        expect((restored as any)._serviceContext).toBe(previous.serviceContext);
        expect((restored as any)._kv).toBe(previous.kv);
        expect((restored as any).auth).toBe(previous.auth);
        expect((restored as any).runtimePermissionGrants).toEqual(previous.grants);
        await fixture.readAndDecrypt(restored, activated);
      };
      for (const rejected of [
        restorableData(publicOnly, sourceDid),
        restorableData({ kty: "OKP", crv: "Ed25519" }, sourceDid),
        restorableData(sourceJwk, unrelatedDid),
        restorableData(sourceJwk, `${sourceDid.split("#", 1)[0]}#not-the-key`),
        restorableData({ ...sourceJwk, alg: "ES256" }, sourceDid),
        { ...fixture.restorableSession, chainId: -1, tinycloudHosts: undefined },
      ]) {
        const error = await restored.restoreSession(rejected).catch((err) => err as Error);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).not.toContain(sourceJwk.d);
        await assertPriorState();
      }
    } finally {
      fixture.stop();
    }
  });

  test("preserves compatibility with custom managers that do not support key replacement", async () => {
    const node = new TinyCloudNode({ host: RESTORE_HOST, wasmBindings: legacyBindings() });
    const initialDid = node.sessionDid;
    const error = await node.restoreSession(restorableData({ d: "private-material-must-not-leak" }, initialDid))
      .catch((err) => err as Error & { code?: string });
    expect(error.name).toBe("UnsupportedSessionRestoreError");
    expect(error.code).toBe("RESTORE_SESSION_KEY_REPLACEMENT_UNSUPPORTED");
    expect(error.message).not.toContain("private-material-must-not-leak");
    expect(node.sessionDid).toBe(initialDid);
  });

  test("stages the persisted SIWE expiry into capability and sharing services", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const restored = fixture.createRestoredDelegate();
      const firstExpiry = new Date(Date.now() + 2 * 60 * 60_000);
      const restoredExpiry = new Date(Date.now() + 3 * 60 * 60_000);

      await restored.restoreSession({
        ...fixture.restorableSession,
        siwe: withSiweExpiration(fixture.restorableSession.siwe, firstExpiry),
      });
      await restored.restoreSession({
        ...fixture.restorableSession,
        siwe: withSiweExpiration(fixture.restorableSession.siwe, restoredExpiry),
      });

      const registry = (restored as any)._capabilityRegistry;
      const sessionKey = registry.getAllKeys()[0];
      const delegations = registry.getDelegationsForKey(sessionKey.id);
      expect(delegations).not.toHaveLength(0);
      expect(delegations.every((delegation: { expiry: Date }) =>
        delegation.expiry.getTime() === restoredExpiry.getTime()
      )).toBe(true);
      expect((restored as any)._sharingService.sessionExpiry.getTime()).toBe(
        restoredExpiry.getTime(),
      );
    } finally {
      fixture.stop();
    }
  });

  test("round-trips a real WASM session JWK, stores the canonical verification method, and cryptographically validates restored-key signing", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const restored = fixture.createRestoredDelegate();
      const defaultDid = restored.sessionDid;

      const bareDid = fixture.restorableSession.verificationMethod.split("#", 1)[0]!;
      await restored.restoreSession({
        ...fixture.restorableSession,
        jwk: { ...(fixture.restorableSession.jwk as object), alg: "EdDSA" },
        verificationMethod: bareDid,
      });

      expect(restored.sessionDid).not.toBe(defaultDid);
      expect(principalDidEquals(restored.sessionDid, bareDid)).toBe(true);
      expect((restored as any)._serviceContext.session.verificationMethod).toBe(
        fixture.restorableSession.verificationMethod,
      );
      expect(restored.restorableSession?.verificationMethod).toBe(fixture.restorableSession.verificationMethod);

      const delegation = await fixture.mintDelegation();
      const activated = await activateValidatedRuntimeDelegation(restored, delegation, {
        host: fixture.host,
      });

      expect(activated.audience).toBe(restored.sessionDid.split("#", 1)[0]);
      expect(restored.getRuntimePermissionDelegations()).toHaveLength(1);
      await fixture.readAndDecrypt(restored, activated);
      fixture.assertNarrowDelegatedReadAndDecrypt(activated, restored.sessionDid);
    } finally {
      fixture.stop();
    }
  });
});
