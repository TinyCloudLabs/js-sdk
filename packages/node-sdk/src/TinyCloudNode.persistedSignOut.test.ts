import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISessionStorage, PersistedSessionData } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { FileSessionStorage } from "./storage/FileSessionStorage";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";
import { unregisteredLocationRegistryResponse } from "./test-support/unregistered-location-registry";

const HOST = "https://persisted-signout.test";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

async function restored(storage?: ISessionStorage) {
  const directory = mkdtempSync(join(tmpdir(), "tc2379-session-"));
  directories.push(directory);
  storage ??= new FileSessionStorage(directory);
  const proof = await signedRestorableSession();
  const persisted: PersistedSessionData = {
    address: proof.address, chainId: proof.chainId,
    sessionKey: JSON.stringify(proof.jwk), siwe: proof.siwe, signature: proof.signature,
    tinycloudSession: {
      delegationHeader: proof.delegationHeader, delegationCid: proof.delegationCid,
      spaceId: proof.spaceId, verificationMethod: proof.verificationMethod,
    },
    expiresAt: proof.expiresAt, createdAt: new Date().toISOString(), version: "1.0",
  };
  await storage.save(proof.address, persisted);
  const node = new TinyCloudNode({
    host: HOST, tinycloudRegistryUrl: null, wasmBindings: new NodeWasmBindings(),
    sessionStorage: storage, autoBootstrapAccount: false,
  });
  await node.restoreSession({ ...proof, tinycloudHosts: [HOST] });
  return { node, storage, directory, proof, persisted };
}

type Stage = "deny" | "registry" | "quiesce" | "erase";
function stallCleanup(node: TinyCloudNode, stage: Stage) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const order: string[] = [];
  const wait = async (at: Stage) => {
    order.push(at);
    if (stage === at) { entered.resolve(); await release.promise; }
  };
  const internal = node as unknown as {
    accountRegistryTail: Promise<void>;
    denyReplicaGate: () => Promise<{ status: string }>;
    quiesceReplicaRuntime: () => Promise<void>;
    eraseReplicaLocalCopy: () => Promise<unknown>;
  };
  internal.denyReplicaGate = async () => { await wait("deny"); return { status: "marker" }; };
  internal.accountRegistryTail = stage === "registry"
    ? (async () => { await wait("registry"); })()
    : Promise.resolve();
  internal.quiesceReplicaRuntime = () => wait("quiesce");
  internal.eraseReplicaLocalCopy = async () => {
    await wait("erase");
    finished.resolve();
    return { outcome: { status: "erased" }, purge: { ok: true } };
  };
  return { entered: entered.promise, release: () => release.resolve(), finished: finished.promise, order };
}

async function settlesBeforeNextTurn<T>(promise: Promise<T>): Promise<T | "still-pending"> {
  // These adapters settle in microtasks; a loop turn distinguishes them from the held cleanup.
  return Promise.race([
    promise,
    new Promise<"still-pending">((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);
}

describe("persisted auth invalidation is independent of replica cleanup", () => {
  for (const stage of ["deny", "registry", "quiesce", "erase"] as const) {
    test(`a fresh file-storage instance cannot restore while ${stage} never resolves`, async () => {
      const { node, directory, proof } = await restored();
      const gate = stallCleanup(node, stage);
      const signingOut = node.signOut();
      signingOut.catch(() => undefined);
      try {
        await gate.entered;
        const fresh = new FileSessionStorage(directory);
        // Boolean assertion: never print a persisted key/session on a failing test.
        expect((await fresh.load(proof.address)) === null).toBe(true);
        expect(node.session === undefined).toBe(true);
      } finally {
        gate.release();
        await signingOut;
      }
    });
  }

  test("a failed auth clear rejects promptly while cleanup stays owned and blocks replacement", async () => {
    const failure = new Error("synthetic auth storage unavailable");
    const backing = new MemorySessionStorage();
    const legacy: ISessionStorage = {
      save: (address, session) => backing.save(address, session),
      load: (address) => backing.load(address),
      clear: async () => { throw failure; },
      exists: (address) => backing.exists(address), isAvailable: () => true,
    };
    const { node, proof } = await restored(legacy);
    const gate = stallCleanup(node, "deny");
    const signingOut = node.signOut();
    const rejected = signingOut.then(() => false, (error) => error === failure);
    try {
      await gate.entered;
      expect(await settlesBeforeNextTurn(rejected)).toBe(true);
      expect(node.signOut() === signingOut).toBe(true);
      let replacementInstalled = false;
      const replacing = node.restoreSession({ ...proof, tinycloudHosts: [HOST] })
        .then(() => { replacementInstalled = true; });
      replacing.catch(() => undefined);
      expect(await settlesBeforeNextTurn(replacing.then(() => "installed"))).toBe("still-pending");
      expect(replacementInstalled).toBe(false);
      gate.release();
      await gate.finished;
      await replacing;
      expect(node.restorableSession?.delegationCid === proof.delegationCid).toBe(true);
      expect(gate.order.slice(0, 3)).toEqual(["deny", "quiesce", "erase"]);
    } finally {
      gate.release();
      await gate.finished;
      await rejected;
    }
  });

  test("an ownership-read failure is not permission to clear a legacy adapter", async () => {
    const failure = new Error("synthetic ownership read unavailable");
    const backing = new MemorySessionStorage();
    let readFails = false;
    let cleared = false;
    const legacy: ISessionStorage = {
      save: (address, session) => backing.save(address, session),
      load: (address) => readFails ? Promise.reject(failure) : backing.load(address),
      clear: async (address) => { cleared = true; await backing.clear(address); },
      exists: (address) => backing.exists(address), isAvailable: () => true,
    };
    const { node, proof } = await restored(legacy);
    readFails = true;
    const error = await node.signOut().then(() => undefined, (caught) => caught);
    expect(error === failure).toBe(true);
    expect(cleared).toBe(false);
    expect(backing.exists(proof.address)).toBe(true);
  });
});

test("replacement-key allocation failure still fences an already pending persistence writer", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const metadata = unregisteredLocationRegistryResponse(input, HOST, init);
    if (metadata) return metadata;
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== HOST) throw new Error("Unexpected test destination");
    if (url.pathname === "/info") return Response.json({ protocol: 1, version: "test", features: [] });
    if (url.pathname === "/delegate") return Response.json({ activated: [], skipped: [] });
    throw new Error("Unexpected test endpoint");
  };
  const saving = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class HeldStorage extends MemorySessionStorage {
    override async save(...args: Parameters<MemorySessionStorage["save"]>): Promise<void> {
      saving.resolve();
      await release.promise;
      return super.save(...args);
    }
  }
  const failure = new Error("synthetic replacement key failure");
  let failReplacement = false;
  class Bindings extends NodeWasmBindings {
    override createSessionManager() {
      if (failReplacement) throw failure;
      return super.createSessionManager();
    }
  }
  const storage = new HeldStorage();
  const signer = new PrivateKeySigner(PROOF_PRIVATE_KEY);
  const node = new TinyCloudNode({
    host: HOST, tinycloudRegistryUrl: HOST, signer, wasmBindings: new Bindings(),
    sessionStorage: storage, autoBootstrapAccount: false, autoCreateSpace: false,
    includeAccountRegistryPermissions: false, enablePublicSpace: false,
  });
  const signingIn = node.signIn().then(() => false, (error) => error instanceof Error);
  try {
    expect(await Promise.race([saving.promise.then(() => true), signingIn.then(() => false)])).toBe(true);
    failReplacement = true;
    expect(await node.signOut().then(() => false, (error) => error === failure)).toBe(true);
    failReplacement = false;
    release.resolve();
    expect(await signingIn).toBe(true);
    expect(storage.exists(await signer.getAddress())).toBe(false);
    expect(node.session === undefined).toBe(true);
  } finally {
    failReplacement = false;
    release.resolve();
    await signingIn;
    globalThis.fetch = originalFetch;
  }
});

test("an external storage subclass keeps its existing clear failure contract", async () => {
  const failure = new Error("synthetic custom adapter clear failure");
  class CustomStorage extends MemorySessionStorage {
    override async clear(): Promise<void> { throw failure; }
  }
  const { node } = await restored(new CustomStorage());
  expect(await node.signOut().then(() => false, (error) => error === failure)).toBe(true);
});
