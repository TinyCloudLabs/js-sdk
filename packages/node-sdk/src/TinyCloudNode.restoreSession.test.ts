import { describe, expect, mock, test } from "bun:test";

import {
  principalDidEquals,
  type Delegation,
  type ISessionManager,
  type IWasmBindings,
  type ServiceContext,
} from "@tinycloud/sdk-core";

import { activateValidatedRuntimeDelegation } from "./delegation";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

const RESTORE_HOST = "http://127.0.0.1:1";
const PROOF_PRIVATE_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";

async function signedRestorableSession(options?: {
  expirationless?: boolean;
  expired?: boolean;
  spaces?: Record<string, string>;
  signedSpaces?: Record<string, string>;
  abilities?: Record<string, Record<string, string[]>>;
}) {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PROOF_PRIVATE_KEY);
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const spaceId = wasm.makeSpaceId(address, chainId, "default");
  const now = new Date();
  const issuedAt = options?.expired
    ? new Date(now.getTime() - 2 * 60 * 60_000)
    : now;
  const expirationTime = options?.expired
    ? new Date(now.getTime() - 60 * 60_000)
    : new Date(now.getTime() + 60 * 60_000);
  const verificationMethod = manager.getDID("default");
  const prepared = options?.expirationless
    ? {
      jwk,
      spaceId,
      verificationMethod,
      siwe: (manager as any).build({
        address,
        chainId,
        domain: "restore.test",
        issuedAt: issuedAt.toISOString(),
      }, "default"),
    }
    : wasm.prepareSession({
      abilities: options?.abilities ?? { kv: { "": ["tinycloud.kv/get"] } },
      address,
      chainId,
      domain: "restore.test",
      issuedAt: issuedAt.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId,
      additionalSpaces: options?.signedSpaces ?? options?.spaces,
      jwk,
    });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const expiresAt = options?.expirationless
    ? new Date(now.getTime() + 30 * 60_000).toISOString()
    : expirationTime.toISOString();
  return {
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    spaceId,
    spaces: options?.spaces,
    jwk,
    verificationMethod,
    address,
    chainId,
    siwe: prepared.siwe,
    signature,
    expiresAt,
  };
}

function restorableData(jwk: object, verificationMethod: string) {
  return {
    delegationHeader: { Authorization: "Bearer restore-test" },
    delegationCid: "bafy-restore-test",
    spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
    jwk,
    verificationMethod,
  };
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
  test("cryptographically binds persisted SIWE authority before trusting its recap, expiry, CID, or header", async () => {
    const proof = await signedRestorableSession();
    const wasm = new NodeWasmBindings();
    expect(() => wasm.validatePersistedSession!(proof)).not.toThrow();
    const unrelatedJwk = JSON.parse(wasm.createSessionManager().jwk("default")!);
    expect(() => wasm.validatePersistedSession!({ ...proof, jwk: unrelatedJwk })).toThrow();
    const expired = await signedRestorableSession({ expired: true });
    expect(() => wasm.validatePersistedSession!({
      ...expired,
      now: new Date(expired.expiresAt).toISOString(),
    } as any)).toThrow();
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: wasm,
    });
    await node.restoreSession({ ...proof, tinycloudHosts: ["https://valid.example"] });
    const priorDid = node.sessionDid;
    const priorHost = node.hosts[0];
    const priorState = {
      auth: (node as any).auth,
      core: (node as any).tc,
      manager: (node as any).sessionManager,
      serviceContext: (node as any)._serviceContext,
    };
    for (const tampered of [
      { ...proof, signature: `${proof.signature.slice(0, -1)}0` },
      { ...proof, siwe: proof.siwe.replace("Chain ID: 1", "Chain ID: 2") },
      { ...proof, delegationCid: `${proof.delegationCid}x` },
      { ...proof, delegationHeader: { Authorization: `${proof.delegationHeader.Authorization}x` } },
      { ...proof, address: "0x0000000000000000000000000000000000000001" },
      { ...proof, chainId: proof.chainId + 1 },
    ]) {
      expect(() => wasm.validatePersistedSession!(tampered)).toThrow();
      await expect(node.restoreSession({ ...tampered, tinycloudHosts: ["https://tampered.example"] })).rejects.toThrow();
      expect(node.sessionDid).toBe(priorDid);
      expect(node.hosts[0]).toBe(priorHost);
      expect((node as any).auth).toBe(priorState.auth);
      expect((node as any).tc).toBe(priorState.core);
      expect((node as any).sessionManager).toBe(priorState.manager);
      expect((node as any)._serviceContext).toBe(priorState.serviceContext);
    }
    await expect(node.restoreSession({
      ...proof,
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    })).rejects.toThrow("does not match its signed SIWE authority");
  });

  test("replaces auth, host, core publicKV, spaces, and all live keys on repeated cross-host restore", async () => {
    const proof = await signedRestorableSession({
      spaces: { public: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:public" },
    });
    const node = new TinyCloudNode({
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
    });
    const manager = (node as any).sessionManager as ISessionManager;
    manager.createSessionKey("secondary");

    await node.restoreSession({ ...proof, tinycloudHosts: ["https://one.example"] });
    await node.restoreSession({ ...proof, tinycloudHosts: ["https://two.example"] });

    expect(node.hosts).toEqual(["https://two.example"]);
    expect((node as any).config.host).toBe("https://two.example");
    expect((node as any).auth.hosts).toEqual(["https://two.example"]);
    expect((node as any).tc.isSignedIn).toBe(true);
    expect(((node as any).tc.serviceContext as { hosts: string[] }).hosts).toEqual(["https://two.example"]);
    expect(() => node.publicKV).not.toThrow();
    expect((node.restorableSession?.spaces)).toEqual(proof.spaces);
    const registry = (node as any)._capabilityRegistry;
    const sessionKey = registry.getAllKeys()[0];
    expect(registry.getDelegationsForKey(sessionKey.id).some((delegation: { spaceId: string }) =>
      delegation.spaceId === proof.spaces!.public
    )).toBe(true);
    expect(((node as any).sessionManager as ISessionManager).listSessionKeys!()).toContain("secondary");
  });

  test("reconstructs every verified narrow ReCap entry without unsigned metadata authority", async () => {
    const proof = await signedRestorableSession({
      spaces: {
        public: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:public",
        unsigned: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:unsigned",
      },
      signedSpaces: {
        public: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:public",
      },
      abilities: {
        kv: { "narrow/": ["tinycloud.kv/get"] },
        sql: { "records/": ["tinycloud.sql/read"] },
      },
    });
    const wasm = new NodeWasmBindings();
    const verified = wasm.validatePersistedSession!(proof);
    const node = new TinyCloudNode({ wasmBindings: wasm });

    await node.restoreSession({ ...proof, tinycloudHosts: ["https://recap.example"] });

    const registry = (node as any)._capabilityRegistry;
    const key = registry.getAllKeys()[0];
    const actual = registry.getDelegationsForKey(key.id).map((delegation: Delegation) => ({
      space: delegation.spaceId,
      path: delegation.path,
      actions: delegation.actions,
    })).sort((left: { space: string; path: string }, right: { space: string; path: string }) =>
      `${left.space}|${left.path}`.localeCompare(`${right.space}|${right.path}`),
    );
    const expected = verified.recap.map((entry) => ({
      space: entry.space,
      path: entry.path,
      actions: entry.actions,
    })).sort((left, right) =>
      `${left.space}|${left.path}`.localeCompare(`${right.space}|${right.path}`),
    );

    expect(actual).toEqual(expected);
    expect(actual.some((entry: { space: string }) => entry.space === proof.spaces!.unsigned)).toBe(false);
    expect(actual.flatMap((entry: { actions: string[] }) => entry.actions)).toEqual(
      expect.arrayContaining(["tinycloud.kv/get", "tinycloud.sql/read"]),
    );
    expect(actual.flatMap((entry: { actions: string[] }) => entry.actions)).not.toContain("tinycloud.kv/put");
  });

  test("retires captured services and aborts in-flight requests after each successful restore", async () => {
    const originalFetch = globalThis.fetch;
    let requestSignal: AbortSignal | undefined;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    globalThis.fetch = mock((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestStarted();
      requestSignal?.addEventListener("abort", () => {
        reject(new DOMException("retired", "AbortError"));
      }, { once: true });
    })) as typeof fetch;

    try {
      const proof = await signedRestorableSession({
        abilities: { kv: { "": ["tinycloud.kv/get", "tinycloud.kv/metadata"] } },
      });
      const node = new TinyCloudNode({
        signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
        wasmBindings: new NodeWasmBindings(),
      });
      await node.restoreSession({ ...proof, tinycloudHosts: ["https://one.example"] });

      const captured = {
        context: (node as any)._serviceContext as ServiceContext,
        core: (node as any).tc,
        kv: node.kv,
        publicKV: node.publicKV,
        sql: node.sql,
        duckdb: node.duckdb,
        hooks: node.hooks,
        vault: node.vault,
        encryption: node.encryption,
        sharing: node.sharing,
        delegations: node.delegationManager,
        spaces: node.spaces,
      };
      const inFlight = captured.kv.get("in-flight");
      await started;

      await node.restoreSession({ ...proof, tinycloudHosts: ["https://two.example"] });

      expect(requestSignal?.aborted).toBe(true);
      await expect(inFlight).resolves.toMatchObject({ ok: false });
      expect(captured.context.session).toBeNull();
      expect(captured.context.abortSignal.aborted).toBe(true);
      expect(() => captured.core.kv).toThrow("Services not initialized");
      await expect(captured.publicKV.get("after")).resolves.toMatchObject({ ok: false });
      await expect(captured.delegations.list()).resolves.toMatchObject({ ok: false });
      await expect(captured.sharing.generate({ path: "after", actions: ["tinycloud.kv/get"] }))
        .resolves.toMatchObject({ ok: false });
      expect(node.hosts).toEqual(["https://two.example"]);

      await node.restoreSession({ ...proof, tinycloudHosts: ["https://three.example"] });
      expect(node.hosts).toEqual(["https://three.example"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not turn an empty ReCap into delegation or sharing authority", async () => {
    const proof = await signedRestorableSession({ expirationless: true });
    const node = new TinyCloudNode({ wasmBindings: new NodeWasmBindings() });

    await node.restoreSession({ ...proof, tinycloudHosts: ["https://empty-recap.example"] });

    expect(node.capabilityRegistry.getAllKeys()).toEqual([]);
    await expect(node.delegateTo("did:key:zEmpty", [{
      service: "tinycloud.kv",
      space: proof.spaceId,
      path: "",
      actions: ["tinycloud.kv/get"],
    }])).rejects.toThrow();
    await expect(node.sharing.generate({
      path: "cannot-share",
      actions: ["tinycloud.kv/get"],
    })).resolves.toMatchObject({ ok: false });
  });

  test("does not inherit wallet metadata or activation skips from a previous live session", async () => {
    const proof = await signedRestorableSession();
    const node = new TinyCloudNode({
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
    });
    await node.restoreSession({ ...proof, tinycloudHosts: ["https://one.example"] });
    (node as any).auth._lastActivationSkippedSpaceIds = [proof.spaceId];
    await node.restoreSession({ ...proof, tinycloudHosts: ["https://two.example"] });
    expect((node as any).runtimePermissionGrants).toHaveLength(1);

    await node.restoreSession({
      delegationHeader: proof.delegationHeader,
      delegationCid: proof.delegationCid,
      spaceId: proof.spaceId,
      jwk: proof.jwk,
      verificationMethod: proof.verificationMethod,
      tinycloudHosts: ["https://three.example"],
    });
    expect(node.address).toBeUndefined();
    expect((node as any).auth.session).toBeUndefined();
    expect(node.hosts).toEqual(["https://three.example"]);
  });

  test("uses the persisted expiry for a valid expiration-less proof and rejects a missing policy expiry", async () => {
    const proof = await signedRestorableSession({ expirationless: true });
    const node = new TinyCloudNode({
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
    });
    await node.restoreSession({ ...proof, tinycloudHosts: ["https://one.example"] });
    const firstExpiry = (node as any)._sharingService.sessionExpiry;
    await node.restoreSession({ ...proof, tinycloudHosts: ["https://two.example"] });
    expect((node as any)._sharingService.sessionExpiry.getTime()).toBe(firstExpiry.getTime());
    await expect(node.restoreSession({ ...proof, expiresAt: undefined })).rejects.toThrow(
      "must include expiresAt",
    );
  });

  test("rejects explicit alg:null and partial key managers without replacing live state", async () => {
    const proof = await signedRestorableSession();
    const node = new TinyCloudNode({ wasmBindings: new NodeWasmBindings() });
    const before = node.sessionDid;
    await expect(node.restoreSession({ ...proof, jwk: { ...proof.jwk, alg: null } })).rejects.toThrow(
      "invalid private Ed25519",
    );
    expect(node.sessionDid).toBe(before);

    const partial = new TinyCloudNode({ host: RESTORE_HOST, wasmBindings: {
      createSessionManager: legacySessionManager,
    } as IWasmBindings });
    const partialDid = partial.sessionDid;
    await expect(partial.restoreSession(restorableData(proof.jwk, proof.verificationMethod))).rejects.toMatchObject({
      name: "UnsupportedSessionRestoreError",
      code: "RESTORE_SESSION_KEY_REPLACEMENT_UNSUPPORTED",
    });
    expect(partial.sessionDid).toBe(partialDid);
  });

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

  test("stages the signed SIWE expiry into capability and sharing services", async () => {
    const proof = await signedRestorableSession();
    const restored = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
    });

    await restored.restoreSession(proof);

    const expectedExpiry = new Date(proof.expiresAt).getTime();
    const registry = (restored as any)._capabilityRegistry;
    const sessionKey = registry.getAllKeys()[0];
    const delegations = registry.getDelegationsForKey(sessionKey.id);
    expect(delegations).not.toHaveLength(0);
    expect(delegations.every((delegation: { expiry: Date }) =>
      delegation.expiry.getTime() === expectedExpiry
    )).toBe(true);
    expect((restored as any)._sharingService.sessionExpiry.getTime()).toBe(expectedExpiry);
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
