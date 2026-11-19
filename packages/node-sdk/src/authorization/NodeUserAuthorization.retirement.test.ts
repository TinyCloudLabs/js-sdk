import "../../../operations/test-support/test-bootstrap.mjs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ISessionStorage } from "@tinycloud/sdk-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStorage } from "../storage/FileSessionStorage";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";
import { richResultFor } from "../test-support/openkey-result";
import { unregisteredLocationRegistryResponse } from "../test-support/unregistered-location-registry";

const HOST = "https://auth-retirement.test";
const REGISTRY = "https://registry.auth-retirement.test";
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = async (input, init) => {
    const registry = unregisteredLocationRegistryResponse(input, REGISTRY, init);
    if (registry) return registry;
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== HOST) throw new Error("Unexpected test destination");
    if (url.pathname === "/info") return Response.json({ protocol: 1, version: "test", features: [] });
    if (url.pathname === "/delegate") return Response.json({ activated: [], skipped: [] });
    throw new Error("Unexpected test endpoint");
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

async function fixture(storage: ISessionStorage = new MemorySessionStorage(), atPersistence?: () => void) {
  const signer = new PrivateKeySigner("1".padStart(64, "0"));
  const bindings = new NodeWasmBindings();
  const addressLookup = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  let hold = false;
  const auth = new NodeUserAuthorization({
    signer: {
      getAddress: async () => { if (hold) { addressLookup.resolve(); await releaseLookup.promise; } return signer.getAddress(); },
      getChainId: () => signer.getChainId(), signMessage: (message) => signer.signMessage(message),
    },
    wasmBindings: bindings, sessionStorage: storage, tinycloudRegistryUrl: REGISTRY,
    tinycloudHosts: [HOST], domain: "auth-retirement.test", signStrategy: { type: "auto-sign" },
    autoCreateSpace: false, includeAccountRegistryPermissions: false,
    establishReplicaStamp: async () => { atPersistence?.(); return undefined; },
  });
  return {
    auth, signer, storage,
    hold: () => { hold = true; },
    waiting: addressLookup.promise,
    release: () => { hold = false; releaseLookup.resolve(); },
  };
}

describe("all sign-in completions retain the initiating generation", () => {
  for (const mode of ["ordinary", "prepared", "OpenKey-result", "OpenKey-pending"] as const) {
    test(`${mode}: a delayed completion cannot persist or publish after direct sign-out`, async () => {
      const f = await fixture();
      const prepared = await f.auth.prepareSessionForSigning();
      const pending = mode === "OpenKey-pending" ? await f.auth.prepareOpenKeySignIn() : undefined;
      const signed = await richResultFor(f.signer, pending?.prepared.siwe ?? prepared.prepared.siwe);
      f.hold();
      const completing = mode === "ordinary" ? f.auth.signIn()
        : mode === "prepared" ? f.auth.signInWithPreparedSession(prepared.prepared, signed.signature, prepared.keyId, prepared.jwk)
        : mode === "OpenKey-pending" ? f.auth.completeOpenKeySignIn(pending!, Promise.resolve(signed))
        : f.auth.signInWithOpenKeyResult(signed, prepared.prepared, prepared.keyId, prepared.jwk);
      const outcome = completing.then(() => false, (error) => error instanceof Error);
      try {
        await f.waiting;
        await f.auth.signOut();
      } finally { f.release(); }
      expect(await outcome).toBe(true);
      expect(f.auth.session === undefined).toBe(true);
      expect((await f.storage.load(await f.signer.getAddress())) === null).toBe(true);
    });
  }
});

test("a cancelled queued writer cannot start a legacy durable save whose acknowledgement hangs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tc2379-queued-"));
  const backing = new FileSessionStorage(directory);
  const acknowledgement = Promise.withResolvers<void>();
  const atPersistence = Promise.withResolvers<void>();
  const queue = Promise.withResolvers<void>();
  const legacy: ISessionStorage = {
    save: async (address, data) => { await backing.save(address, data); await acknowledgement.promise; },
    load: (address) => backing.load(address), clear: (address) => backing.clear(address),
    exists: (address) => backing.exists(address), isAvailable: () => true,
  };
  const f = await fixture(legacy, () => atPersistence.resolve());
  (f.auth as unknown as { persistenceQueue: Promise<void> }).persistenceQueue = queue.promise;
  const completing = f.auth.signIn().then(() => false, (error) => error instanceof Error);
  try {
    await atPersistence.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.auth.signOut();
    queue.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await new FileSessionStorage(directory).load(await f.signer.getAddress())) === null).toBe(true);
    expect(await completing).toBe(true);
  } finally {
    queue.resolve();
    acknowledgement.resolve();
    await completing;
    rmSync(directory, { recursive: true });
  }
});
