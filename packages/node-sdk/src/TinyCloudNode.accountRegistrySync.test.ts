/**
 * TC-110 — recap-gated account spaces sync.
 *
 * After OpenKey/manifest sign-in, `scheduleAccountRegistrySync()` used to
 * unconditionally call `account.spaces.syncAccessible()`, which invokes
 * `tinycloud.space/list` — a capability a manifest/recap session never holds —
 * producing a benign but noisy `401 Unauthorized Action` on every sign-in.
 *
 * The guard: skip `syncAccessible()` when the current session's recap does not
 * grant `tinycloud.space/list`. Only sessions with NO parseable recap
 * (session-only / restored-without-siwe) keep today's behavior.
 *
 * These tests pin the empirically-resolved gating question (see the file's
 * findings note): a DEFAULT non-manifest recap has NO `space` service entry —
 * its abilities table is kv/sql/duckdb/capabilities/hooks — so it is gated the
 * same as a manifest recap. Only the no-recap (ops.length === 0) case runs
 * `syncAccessible()`.
 */

import { afterEach, describe, expect, jest, mock, spyOn, test, type Mock } from "bun:test";
import { inspect } from "node:util";
import { SQLMigrations } from "@tinycloud/sdk-services";

import {
  AccountService,
  KVService,
  ServiceContext,
  SQLService,
  authorizationVerdictOf,
  composeManifestRequest,
  submitHostDelegation,
  type ISessionManager,
  type ISpaceService,
  type IWasmBindings,
  type Manifest,
  type SpaceHostResult,
} from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function flushMicrotasks(): Promise<void> {
  // Two macrotask hops are enough to settle `scheduleAccountRegistrySync`'s
  // fire-and-forget chain (index.ensure → writeManifestRegistryRecords → guard
  // → syncAccessible), all of which resolve synchronously in these tests.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Did `warnSpy` receive a call whose first argument contains `needle`? Used
 * instead of exact call counts because unrelated suites' fire-and-forget
 * background tasks can emit their own `console.warn` inside our test window.
 */
function warnedWith(warnSpy: ReturnType<typeof mock>, needle: string): boolean {
  return warnSpy.mock.calls.some((call: unknown[]) =>
    String(call[0] ?? "").includes(needle),
  );
}

function makeFakeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function makeFakeWasmBindings(): IWasmBindings {
  return {
    invoke: mock(() => ({})) as any,
    invokeAny: mock(() => ({})) as any,
    prepareSession: mock((cfg: any) => ({
      siwe: "runtime-siwe",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: "did:key:runtime",
    })) as any,
    completeSessionSetup: mock((cfg: any) => ({
      delegationHeader: { Authorization: "runtime-token" },
      delegationCid: "runtime-cid",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: cfg.verificationMethod,
    })) as any,
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    createDelegation: mock(() => ({})) as any,
    parseRecapFromSiwe: mock(() => [] as any[]) as any,
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_x25519_from_seed: mock(() => ({
      publicKey: new Uint8Array(),
      privateKey: new Uint8Array(),
    })),
    vault_x25519_dh: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array()),
    vault_sha256: mock(() => new Uint8Array()),
    createSessionManager: makeFakeSessionManager,
  };
}

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const SPACE_URI = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
const ACCOUNT_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;

function siweFor(): string {
  return `tinycloud.test wants you to sign in with your Ethereum account:
${ADDRESS}

Sign in.

URI: https://tinycloud.test
Version: 1
Chain ID: 1
Nonce: 32891756
Issued At: 2026-05-05T00:00:00.000Z
Expiration Time: 2999-01-01T00:00:00.000Z`;
}

/**
 * Build a node with a directly-injected primary session and a fake account
 * whose `spaces.syncAccessible` / `index.ensure` are spies. `hasSiwe: false`
 * models the no-recap (session-only / restored) case.
 */
function makeNode(options: { hasSiwe?: boolean } = {}): {
  node: TinyCloudNode;
  wasm: IWasmBindings;
  syncAccessible: ReturnType<typeof mock>;
} {
  const wasm = makeFakeWasmBindings();
  const signer = {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
    signMessage: mock(async () => "0xsig"),
  };
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: signer as any,
    wasmBindings: wasm,
  });

  (node as any).auth = {
    tinyCloudSession: {
      address: ADDRESS,
      chainId: 1,
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
      sessionKey: "default",
      siwe: options.hasSiwe === false ? undefined : siweFor(),
      spaceId: SPACE_URI,
      verificationMethod: "did:key:default",
    },
  };

  Reflect.set(node, "_address", ADDRESS);
  Reflect.set(node, "_chainId", 1);
  const syncAccessible = mock(async () => ({ ok: true, data: [] }));
  (node as any)._account = {
    index: { ensure: mock(async () => ({ ok: true, data: undefined })) },
    spaces: { syncAccessible },
  };
  const context = new ServiceContext({
    invoke: () => ({ Authorization: "registry" }),
    hosts: ["https://tinycloud.test"],
    fetch: async () => new Response(null, { status: 200 }),
  });
  context.setSession({
    delegationHeader: { Authorization: "registry" },
    delegationCid: "registry",
    spaceId: SPACE_URI,
    verificationMethod: "did:key:default",
    jwk: {},
  });
  (node as any)._serviceContext = context;
  (node as any).createAccountRegistryServices = (operationContext: ServiceContext) => ({
    account: (node as any)._account,
    contexts: [operationContext],
  });

  return { node, wasm, syncAccessible };
}

/** Settle promise chains without advancing (fake) timers. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

/**
 * Sign in with fake timers frozen. Fails fast (instead of hanging) if sign-in
 * waits on the registry sync or any of its timers.
 */
async function signInWithoutTimers(node: TinyCloudNode): Promise<void> {
  let signedIn = false;
  const signIn = node.signIn().then(() => {
    signedIn = true;
  });
  await settleMicrotasks();
  expect(signedIn).toBe(true);
  await signIn;
}

/**
 * Stub every sign-in step around the registry sync. The real
 * `scheduleAccountRegistrySync` runs against `makeNode`'s registry services.
 */
function stubSignInSteps(node: TinyCloudNode): void {
  const core = Reflect.get(node, "tc");
  const auth = Reflect.get(node, "auth");
  if (!core || typeof core !== "object" || !auth || typeof auth !== "object") {
    throw new Error("Sign-in dependencies are unavailable");
  }
  Reflect.set(node, "_restoredTcSession", Reflect.get(auth, "tinyCloudSession"));
  Reflect.set(auth, "hosts", ["https://tinycloud.test"]);
  Reflect.set(core, "signIn", async () => {});
  const serviceContext = Reflect.get(node, "_serviceContext");
  Reflect.set(node, "initializeServices", async () => {
    Reflect.set(node, "_serviceContext", serviceContext);
  });
  Reflect.set(node, "registerPrimarySessionGrant", () => {});
  Reflect.set(node, "bootstrapAccountIfNeeded", async () => false);
  Reflect.set(node, "ensureRequestedEncryptionNetworks", async () => {});
  Reflect.set(node, "ensureOwnedSpaceHostedById", async () => {});
}

/** A registry whose index step takes `ms` (fake) milliseconds, or until aborted. */
function slowRegistry(node: TinyCloudNode, ms: number): { written: () => boolean; signals: AbortSignal[] } {
  let written = false;
  const signals: AbortSignal[] = [];
  Reflect.set(node, "createAccountRegistryServices", (context: ServiceContext, signal: AbortSignal) => {
    signals.push(signal);
    return {
      contexts: [context],
      account: {
        index: {
          ensure: () => {
            const { promise, resolve, reject } = Promise.withResolvers<{ ok: true; data: undefined }>();
            const timer = setTimeout(() => resolve({ ok: true, data: undefined }), ms);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(signal.reason);
            }, { once: true });
            return promise;
          },
        },
        spaces: { syncAccessible: async () => ({ ok: true, data: [] }) },
      },
    };
  });
  Reflect.set(node, "writeManifestRegistryRecords", async () => {
    written = true;
  });
  return { written: () => written, signals };
}

describe("sign-in account registry sync runs in the background (TC-998)", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("signIn resolves while a 10 s registry sync is still running, and the sync still writes", async () => {
    jest.useFakeTimers();
    const { node } = makeNode();
    stubSignInSteps(node);
    const registry = slowRegistry(node, 10_000);

    await signInWithoutTimers(node);
    expect(registry.signals).toHaveLength(1);
    expect(registry.written()).toBe(false);

    let synced = false;
    const waited = node.waitForAccountRegistrySync().then(() => {
      synced = true;
    });
    jest.advanceTimersByTime(9_999);
    await settleMicrotasks();
    expect(synced).toBe(false);

    jest.advanceTimersByTime(1);
    await settleMicrotasks();
    expect(synced).toBe(true);
    await waited;
    expect(registry.written()).toBe(true);
    expect(registry.signals[0]?.aborted).toBe(false);
  });

  test("a first write after waitForAccountRegistrySync() starts only after the registry writes settle", async () => {
    jest.useFakeTimers();
    const { node } = makeNode();
    stubSignInSteps(node);
    const order: string[] = [];
    slowRegistry(node, 5_000);
    Reflect.set(node, "writeManifestRegistryRecords", async () => {
      order.push("registry write");
    });

    await signInWithoutTimers(node);
    const firstWrite = node.waitForAccountRegistrySync().then(() => {
      order.push("app write");
    });
    await settleMicrotasks();
    expect(order).toEqual([]);

    jest.advanceTimersByTime(5_000);
    await settleMicrotasks();
    expect(order).toEqual(["registry write", "app write"]);
    await firstWrite;
  });

  test("the hang guard aborts a sync that outlives it and the session stays usable", async () => {
    jest.useFakeTimers();
    const { node } = makeNode();
    stubSignInSteps(node);
    const registry = slowRegistry(node, 60_000);
    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      await signInWithoutTimers(node);
      const session = node.restorableSession;
      jest.advanceTimersByTime(29_999);
      await settleMicrotasks();
      expect(registry.signals[0]?.aborted).toBe(false);

      jest.advanceTimersByTime(1);
      let synced = false;
      void node.waitForAccountRegistrySync().then(() => {
        synced = true;
      });
      await settleMicrotasks();
      expect(synced).toBe(true);
      expect(registry.signals[0]?.aborted).toBe(true);
      expect(registry.written()).toBe(false);
      expect(warnedWith(warnSpy, "deadline exceeded")).toBe(true);

      expect(node.restorableSession).toBe(session);
      const createScopedKV = Reflect.get(node, "createSpaceScopedKVService") as (spaceId: string) => KVService;
      const put = await createScopedKV.call(node, SPACE_URI).put("after-guard", { ok: true });
      expect(put.ok).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("background sync failures are logged, never unhandled", async () => {
    const { node } = makeNode();
    stubSignInSteps(node);
    Reflect.set(node, "createAccountRegistryServices", () => {
      throw new Error("registry services unavailable");
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      await node.signIn();
      await node.waitForAccountRegistrySync();
      // Unhandled rejections are reported after the current macrotask.
      const nextTask = Promise.withResolvers<void>();
      setImmediate(nextTask.resolve);
      await nextTask.promise;
      expect(warnedWith(warnSpy, "account registry sync failed")).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      console.warn = originalWarn;
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("TC-994: a space the sign-in activation listed as activated is not re-hosted after sign-in", async () => {
    const { node } = makeNode();
    stubSignInSteps(node);
    slowRegistry(node, 0);
    const auth = Reflect.get(node, "auth");
    Reflect.set(auth, "lastActivationActivatedSpaceIds", [ACCOUNT_SPACE]);
    const hostOwnedSpaceResult = mock(async () => ({ success: true, status: 200 }));
    Reflect.set(auth, "hostOwnedSpaceResult", hostOwnedSpaceResult);
    const registryRead = mock(async () => {
      throw new Error("registry read must not be needed");
    });
    Reflect.set(node, "isOwnedSpaceRegistered", registryRead);

    await node.signIn();
    expect(await node.ensureOwnedSpaceHosted("account")).toBe(ACCOUNT_SPACE);

    expect(hostOwnedSpaceResult).not.toHaveBeenCalled();
    expect(registryRead).not.toHaveBeenCalled();
    await node.waitForAccountRegistrySync();
  });

  test("TC-998: a host in flight from a replaced session is not shared with the new session", async () => {
    const { node } = makeNode();
    stubSignInSteps(node);
    slowRegistry(node, 0);
    const auth = Reflect.get(node, "auth");
    const approvals: Array<PromiseWithResolvers<{ success: true; status: number }>> = [];
    const hostOwnedSpaceResult = mock(() => {
      const approval = Promise.withResolvers<{ success: true; status: number }>();
      approvals.push(approval);
      return approval.promise;
    });
    Reflect.set(auth, "hostOwnedSpaceResult", hostOwnedSpaceResult);
    Reflect.set(node, "isOwnedSpaceRegistered", async () => false);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ activated: [], skipped: [] })) as unknown as typeof fetch;
    try {
      await node.signIn();
      const before = node.ensureOwnedSpaceHosted("account");
      await settleMicrotasks();
      expect(approvals).toHaveLength(1);

      await node.signIn();
      const after = node.ensureOwnedSpaceHosted("account");
      await settleMicrotasks();
      expect(approvals).toHaveLength(2);

      for (const approval of approvals) approval.resolve({ success: true, status: 200 });
      expect(await Promise.all([before, after])).toEqual([ACCOUNT_SPACE, ACCOUNT_SPACE]);
      await node.waitForAccountRegistrySync();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("sign-in account registry barrier", () => {
  test("a new sign-in aborts the replaced session's hung registry request instead of waiting", async () => {
    const { node } = makeNode();
    const core = Reflect.get(node, "tc");
    const auth = Reflect.get(node, "auth");
    if (!core || typeof core !== "object" || !auth || typeof auth !== "object") {
      throw new Error("Sign-in dependencies are unavailable");
    }
    Reflect.set(node, "_restoredTcSession", Reflect.get(auth, "tinyCloudSession"));
    Reflect.set(auth, "hosts", ["https://tinycloud.test"]);
    Reflect.set(core, "signIn", async () => {});
    Reflect.set(node, "accountRegistryDeadlineMs", 40);
    const requestSignals: AbortSignal[] = [];
    const requestStarted = Promise.withResolvers<void>();
    const context = new ServiceContext({
      invoke: () => ({ Authorization: "registry" }),
      hosts: ["https://tinycloud.test"],
      fetch: async (_input, init) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        const signal = init?.signal;
        if (!signal) throw new Error("Registry request did not receive an AbortSignal");
        requestSignals.push(signal);
        requestStarted.resolve();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        return promise;
      },
    });
    context.setSession({
      delegationHeader: { Authorization: "registry" },
      delegationCid: "registry",
      spaceId: SPACE_URI,
      verificationMethod: "did:key:default",
      jwk: {},
    });
    Reflect.set(node, "_account", {
      index: {
        ensure: async () => {
          const sql = node.sqlForSpace(SPACE_URI);
          const result = await sql.execute("CREATE TABLE registry_deadline (id INTEGER)");
          return result.ok
            ? { ok: true, data: undefined }
            : { ok: false, error: result.error };
        },
      },
      spaces: { syncAccessible: async () => ({ ok: true, data: [] }) },
    });
    Reflect.set(node, "_serviceContext", context);
    Reflect.deleteProperty(node, "createAccountRegistryServices");
    const scheduleRegistry = Reflect.get(node, "scheduleAccountRegistrySync");
    if (typeof scheduleRegistry !== "function") throw new Error("Registry scheduler is unavailable");
    Reflect.set(node, "accountRegistryTail", Promise.resolve());
    // Start a registry queue with the same session and service graph sign-in drains.
    scheduleRegistry.call(node);
    expect(Reflect.get(node, "pendingAccountRegistrySync")).toBeDefined();
    Reflect.set(node, "initializeServices", async () => {});
    Reflect.set(node, "registerPrimarySessionGrant", () => {});
    Reflect.set(node, "bootstrapAccountIfNeeded", async () => true);
    Reflect.set(node, "ensureRequestedEncryptionNetworks", async () => {});
    Reflect.set(node, "ensureOwnedSpaceHostedById", async () => {});

    // This integration test deliberately uses the platform clock: the property
    // under test is that native AbortSignal cancellation beats a hung fetch.
    // Exercise signIn while the SQL request is already hung on the wire.
    await requestStarted.promise;
    const started = Date.now();
    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      await node.signIn();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnedWith(warnSpy, "deadline exceeded")).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0]?.aborted).toBe(true);
  });
  test("aborts a hung manifest registry KV write and permits an ordinary KV call afterward", async () => {
    const { node } = makeNode();
    const core = Reflect.get(node, "tc");
    const auth = Reflect.get(node, "auth");
    if (!core || typeof core !== "object" || !auth || typeof auth !== "object") {
      throw new Error("Sign-in dependencies are unavailable");
    }
    Reflect.set(node, "_restoredTcSession", Reflect.get(auth, "tinyCloudSession"));
    Reflect.set(node, "_address", ADDRESS);
    Reflect.set(auth, "hosts", ["https://tinycloud.test"]);
    Reflect.set(core, "signIn", async () => {});
    Reflect.set(node, "accountRegistryDeadlineMs", 40);
    const signals: AbortSignal[] = [];
    let requests = 0;
    const requestStarted = Promise.withResolvers<void>();
    const fetchRegistry = async (_input: string, init?: { signal?: AbortSignal }): Promise<Response> => {
      requests += 1;
      const signal = init?.signal;
      if (!signal) throw new Error("Registry KV request did not receive an AbortSignal");
      signals.push(signal);
      if (requests > 1) return new Response(null, { status: 200 });
      requestStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const context = new ServiceContext({
      invoke: () => ({ Authorization: "registry" }),
      hosts: ["https://tinycloud.test"],
      fetch: fetchRegistry,
    });
    context.setSession({
      delegationHeader: { Authorization: "registry" },
      delegationCid: "registry",
      spaceId: SPACE_URI,
      verificationMethod: "did:key:default",
      jwk: {},
    });
    Reflect.set(node, "_serviceContext", context);
    Reflect.set(node, "createAccountRegistryServices", (
      operationContext: ServiceContext,
      signal: AbortSignal,
    ) => {
      const operationKVContext = new ServiceContext({
        invoke: operationContext.invoke,
        hosts: operationContext.hosts,
        fetch: operationContext.fetch,
      });
      operationKVContext.setOperationAbortSignal(signal);
      operationKVContext.setSession({
        delegationHeader: { Authorization: "registry" },
        delegationCid: "registry",
        spaceId: ACCOUNT_SPACE,
        verificationMethod: "did:key:default",
        jwk: {},
      });
      const operationKV = new KVService({});
      operationKV.initialize(operationKVContext);
      const operationAccount = new AccountService({
        getDid: () => `did:pkh:eip155:1:${ADDRESS}`,
        getHost: () => "https://tinycloud.test",
        getPrimarySpaceId: () => SPACE_URI,
        getAccountSpaceId: () => ACCOUNT_SPACE,
        getSpaces: () => ({ get: () => ({ kv: operationKV }) }) as unknown as ISpaceService,
        getAccountDb: () => undefined,
      });
      return { account: operationAccount, contexts: [operationContext, operationKVContext] };
    });
    const createScopedKV = Reflect.get(node, "createSpaceScopedKVService") as (spaceId: string) => KVService;
    const registryKV = createScopedKV.call(node, ACCOUNT_SPACE);
    Reflect.set(node, "_account", new AccountService({
      getDid: () => `did:pkh:eip155:1:${ADDRESS}`,
      getHost: () => "https://tinycloud.test",
      getPrimarySpaceId: () => SPACE_URI,
      getAccountSpaceId: () => ACCOUNT_SPACE,
      getSpaces: () => ({ get: () => ({ kv: registryKV }) }) as unknown as ISpaceService,
      getAccountDb: () => undefined,
    }));
    Reflect.set(auth, "capabilityRequest", composeManifestRequest([{
      app_id: "com.example.registry",
      name: "Registry",
      defaults: false,
      permissions: [{ service: "tinycloud.kv", space: "applications", path: "com.example.registry/", actions: ["put"] }],
    }]));
    const schedule = Reflect.get(node, "scheduleAccountRegistrySync");
    schedule.call(node);
    Reflect.set(node, "initializeServices", async () => {
      const activeContext = new ServiceContext({
        invoke: () => ({ Authorization: "registry" }),
        hosts: ["https://tinycloud.test"],
        fetch: fetchRegistry,
      });
      activeContext.setSession({
        delegationHeader: { Authorization: "registry" },
        delegationCid: "registry",
        spaceId: SPACE_URI,
        verificationMethod: "did:key:default",
        jwk: {},
      });
      Reflect.set(node, "_serviceContext", activeContext);
    });
    Reflect.set(node, "registerPrimarySessionGrant", () => {});
    Reflect.set(node, "bootstrapAccountIfNeeded", async () => true);
    Reflect.set(node, "ensureRequestedEncryptionNetworks", async () => {});
    Reflect.set(node, "ensureOwnedSpaceHostedById", async () => {});

    await requestStarted.promise;
    const started = Date.now();
    await node.signIn();
    expect(Date.now() - started).toBeLessThan(250);
    expect(signals[0]?.aborted).toBe(true);
    expect(requests).toBe(1);

    const ordinaryKV = createScopedKV.call(node, ACCOUNT_SPACE);
    const ordinary = await ordinaryKV.put("after-sign-in", { ok: true });
    expect(ordinary.ok).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    expect(requests).toBe(2);
  });

  test("aborts while a registry SQL error body is still being read", async () => {
    const { node } = makeNode();
    const core = Reflect.get(node, "tc");
    const auth = Reflect.get(node, "auth");
    if (!core || typeof core !== "object" || !auth || typeof auth !== "object") {
      throw new Error("Sign-in dependencies are unavailable");
    }
    Reflect.set(node, "_restoredTcSession", Reflect.get(auth, "tinyCloudSession"));
    Reflect.set(auth, "hosts", ["https://tinycloud.test"]);
    Reflect.set(core, "signIn", async () => {});
    Reflect.set(node, "accountRegistryDeadlineMs", 40);
    const signals: AbortSignal[] = [];
    let requests = 0;
    const requestStarted = Promise.withResolvers<void>();
    const context = new ServiceContext({
      invoke: () => ({ Authorization: "registry" }),
      hosts: ["https://tinycloud.test"],
      fetch: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Registry SQL request did not receive an AbortSignal");
        signals.push(signal);
        requests += 1;
        requestStarted.resolve();
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: { get: () => null },
          json: async () => ({}),
          text: () => new Promise<string>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
          blob: async () => new Blob(),
        };
      },
    });
    context.setSession({
      delegationHeader: { Authorization: "registry" },
      delegationCid: "registry",
      spaceId: SPACE_URI,
      verificationMethod: "did:key:default",
      jwk: {},
    });
    Reflect.set(node, "_serviceContext", context);
    Reflect.deleteProperty(node, "createAccountRegistryServices");
    Reflect.set(node, "_account", {
      index: {
        ensure: async () => {
          const sql = node.sqlForSpace(SPACE_URI);
          const result = await sql.execute("CREATE TABLE registry_deadline (id INTEGER)");
          return result.ok ? { ok: true, data: undefined } : { ok: false, error: result.error };
        },
      },
      applications: { register: async () => ({ ok: true, data: undefined }) },
      spaces: { syncAccessible: async () => ({ ok: true, data: [] }) },
    });
    const schedule = Reflect.get(node, "scheduleAccountRegistrySync");
    schedule.call(node);
    Reflect.set(node, "initializeServices", async () => {});
    Reflect.set(node, "registerPrimarySessionGrant", () => {});
    Reflect.set(node, "bootstrapAccountIfNeeded", async () => true);
    Reflect.set(node, "ensureRequestedEncryptionNetworks", async () => {});
    Reflect.set(node, "ensureOwnedSpaceHostedById", async () => {});

    await requestStarted.promise;
    const started = Date.now();
    await node.signIn();
    expect(Date.now() - started).toBeLessThan(250);
    expect(signals[0]?.aborted).toBe(true);
    expect(requests).toBe(1);
  });


  test("index exception warns once and sign-in still succeeds without registry retries", async () => {
    const { node, syncAccessible } = makeNode({ hasSiwe: false });
    const core = Reflect.get(node, "tc");
    const auth = Reflect.get(node, "auth");
    if (!core || typeof core !== "object" || !auth || typeof auth !== "object") {
      throw new Error("Sign-in dependencies are unavailable");
    }
    Reflect.set(node, "_restoredTcSession", Reflect.get(auth, "tinyCloudSession"));
    Reflect.set(auth, "hosts", ["https://tinycloud.test"]);
    Reflect.set(core, "signIn", async () => {});
    Reflect.set(node, "accountRegistryDeadlineMs", 4_000);
    const ensure = mock(async () => { throw new Error("registry unavailable"); });
    Reflect.set(node, "_account", {
      index: { ensure },
      spaces: { syncAccessible },
    });
    const serviceContext = Reflect.get(node, "_serviceContext");
    Reflect.set(node, "initializeServices", async () => {
      Reflect.set(node, "_serviceContext", serviceContext);
    });
    Reflect.set(node, "registerPrimarySessionGrant", () => {});
    Reflect.set(node, "bootstrapAccountIfNeeded", async () => false);
    Reflect.set(node, "ensureRequestedEncryptionNetworks", async () => {});
    Reflect.set(node, "ensureOwnedSpaceHostedById", async () => {});

    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      await node.signIn();
      await node.waitForAccountRegistrySync();
    } finally {
      console.warn = originalWarn;
    }
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(syncAccessible).toHaveBeenCalledTimes(1);
    expect(warnedWith(warnSpy, "account index initialization failed")).toBe(true);
    expect(warnedWith(warnSpy, "failed after retries")).toBe(false);
  }, 5_000);
});

describe("TC-110: scheduleAccountRegistrySync recap gate", () => {
  test("default non-manifest recap (no space entry) → skips syncAccessible", async () => {
    const { node, wasm, syncAccessible } = makeNode();
    // Default non-manifest recap: kv + sql, NO space service. This mirrors the
    // real abilities table asserted in signInManifest's "no manifest" test.
    (wasm.parseRecapFromSiwe as any).mockImplementation(() => [
      { service: "kv", space: SPACE_URI, path: "", actions: ["tinycloud.kv/get"] },
      { service: "sql", space: SPACE_URI, path: "", actions: ["tinycloud.sql/read"] },
    ]);

    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as any;
    try {
      (node as any).scheduleAccountRegistrySync();
      await flushMicrotasks();
    } finally {
      console.warn = originalWarn;
    }

    expect(syncAccessible).not.toHaveBeenCalled();
    // No doomed space/list invoke → no account-registry warning of our own.
    expect(warnedWith(warnSpy, "failed after retries")).toBe(false);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
  });

  test("recap granting tinycloud.space/list → calls syncAccessible", async () => {
    const { node, wasm, syncAccessible } = makeNode();
    (wasm.parseRecapFromSiwe as any).mockImplementation(() => [
      { service: "kv", space: SPACE_URI, path: "", actions: ["tinycloud.kv/get"] },
      {
        service: "space",
        space: SPACE_URI,
        path: "",
        actions: ["tinycloud.space/list"],
      },
    ]);

    (node as any).scheduleAccountRegistrySync();
    await waitFor(() => syncAccessible.mock.calls.length > 0);

    expect(syncAccessible).toHaveBeenCalledTimes(1);
  });

  test("recap granting the space/* wildcard → calls syncAccessible", async () => {
    const { node, wasm, syncAccessible } = makeNode();
    (wasm.parseRecapFromSiwe as any).mockImplementation(() => [
      { service: "space", space: SPACE_URI, path: "", actions: ["tinycloud.space/*"] },
    ]);

    (node as any).scheduleAccountRegistrySync();
    await waitFor(() => syncAccessible.mock.calls.length > 0);

    expect(syncAccessible).toHaveBeenCalledTimes(1);
  });

  test("no parseable recap (session-only / full-authority) → calls syncAccessible", async () => {
    // hasSiwe:false → recapOperationsFromSession returns [] → preserve today's
    // behavior. Pins the full-authority/no-recap decision from the brief.
    const { node, syncAccessible } = makeNode({ hasSiwe: false });

    (node as any).scheduleAccountRegistrySync();
    await waitFor(() => syncAccessible.mock.calls.length > 0);

    expect(syncAccessible).toHaveBeenCalledTimes(1);
  });
});

describe("TC-110: withAccountRegistryRetry verdict-aware retry", () => {
  let restoreMigrationApply: (() => void) | undefined;
  afterEach(() => {
    restoreMigrationApply?.();
    restoreMigrationApply = undefined;
  });
  test("Unauthorized Action error runs the task exactly once (no retry)", async () => {
    const { node } = makeNode();
    const task = mock(async () => {
      throw new Error(
        "Unauthorized Action: tinycloud:pkh:eip155:1:0x0:default/space/ tinycloud.space/list",
      );
    });

    const originalWarn = console.warn;
    const warnSpy = mock((..._args: unknown[]) => {});
    console.warn = warnSpy as any;
    try {
      await (node as any).withAccountRegistryRetry(task, new AbortController().signal);
    } finally {
      console.warn = originalWarn;
    }

    expect(task).toHaveBeenCalledTimes(1);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(true);
    expect(authorizationVerdictOf(warnedError(warnSpy, "authorization verdict is not retryable"))).toBeUndefined();
  });

  test("401-shaped error runs the task exactly once (no retry)", async () => {
    const { node } = makeNode();
    const task = mock(async () => {
      throw new Error("request failed: 401");
    });

    const originalWarn = console.warn;
    const warnSpy = mock((..._args: unknown[]) => {});
    console.warn = warnSpy as any;
    try {
      await (node as any).withAccountRegistryRetry(task, new AbortController().signal);
    } finally {
      console.warn = originalWarn;
    }

    expect(task).toHaveBeenCalledTimes(1);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(true);
    expect(authorizationVerdictOf(warnedError(warnSpy, "authorization verdict is not retryable"))).toBeUndefined();
  });

  test.each([
    "upstream body said Unauthorized Action",
    "request failed: 500 - body mentions 401",
  ])("untyped incidental text %s does not short-circuit", async (message) => {
    const { node } = makeNode();
    const task = mock(async () => {
      throw new Error(message);
    });
    const originalWarn = console.warn;
    const warnSpy = mock((..._args: unknown[]) => {});
    console.warn = warnSpy;
    try {
      const retry = Reflect.get(node, "withAccountRegistryRetry") as (
        task: () => Promise<void>, signal: AbortSignal,
      ) => Promise<void>;
      await retry.call(node, task, new AbortController().signal);
    } finally {
      console.warn = originalWarn;
    }
    expect(task).toHaveBeenCalledTimes(3);
    expect(warnedWith(warnSpy, "failed after retries")).toBe(true);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
  }, 10_000);

  const AUTH_BODIES = [
    "",
    "Unauthorized Action: tinycloud:pkh:eip155:1:0x0:account/kv/applications/ tinycloud.kv/put",
    "Forbidden",
    "session expired",
  ];
  /**
   * Where the 401/403 is injected:
   * - `index.ensure`: a real SQL migration pre-read over a failing SQLService query.
   * - `spaces.syncAccessible`: a real `KVService.put` failure returned as the sync result.
   * - `applications.register`: the real `AccountService.applications.register`
   *   (through `accountErr`) over a real failing `KVService.put`.
   * - `owned-space activation`: the first real `POST /delegate` activation.
   * - `owned-space create`: activation 404s, then the real host delegation
   *   (`submitHostDelegation`) fails.
   * - `post-create activation`: activation 404s, hosting succeeds, then the
   *   re-activation fails.
   */
  type Wrapper =
    | "index.ensure"
    | "spaces.syncAccessible"
    | "applications.register"
    | "owned-space activation"
    | "owned-space create"
    | "post-create activation";
  const WRAPPERS: Wrapper[] = [
    "spaces.syncAccessible",
    "applications.register",
    "owned-space activation",
    "owned-space create",
    "post-create activation",
  ];
  const HOST_DELEGATION_AUTHORIZATION = "host-delegation";
  const MANIFEST: Manifest = {
    app_id: "com.example.registry",
    name: "Registry",
    defaults: false,
    permissions: [
      { service: "tinycloud.kv", space: "applications", path: "com.example.registry/", actions: ["get"] },
    ],
  };

  type IndexFailure = "403" | "transient" | "throwing-ensure" | "marked-transport" | "registry-500";
  const INDEX_MARKER = "MARKER-index-warning-canary";

  function markedTransportError(): Error {
    return Object.assign(new Error(`SQL transport failure ${INDEX_MARKER}`), {
      config: { headers: { Authorization: INDEX_MARKER } },
    });
  }

  function indexWarnings(warnings: Mock<(...args: unknown[]) => void>): unknown[][] {
    return warnings.mock.calls.filter((args) => String(args[0]).includes("account index"));
  }

  async function runRealIndexSync(failure: IndexFailure): Promise<{
    ensureAttempts: number;
    writtenKeys: string[];
    spaceLists: number;
    registryWrites: number;
    warnSpy: Mock<(...args: unknown[]) => void>;
  }> {
    const { node } = makeNode({ hasSiwe: false });
    const internals = node as unknown as RegistrySyncInternals;
    internals.auth.capabilityRequest = composeManifestRequest([MANIFEST]);
    // Only the transport and, for the rejecting-ensure case, the SQL migration
    // service boundary are stubbed. Scheduling, retry, account and KV stay real.
    Reflect.deleteProperty(node, "createAccountRegistryServices");
    let ensureAttempts = 0;
    let nextSqlIsEnsure = true;
    let registryWrites = 0;
    let spaceLists = 0;
    let activations = 0;
    const writtenKeys: string[] = [];

    if (failure === "throwing-ensure") {
      const originalApply = SQLMigrations.prototype.apply;
      let first = true;
      const migrationSpy = spyOn(SQLMigrations.prototype, "apply").mockImplementation(function (
        this: SQLMigrations, options,
      ) {
        if (first) {
          first = false;
          ensureAttempts += 1;
          nextSqlIsEnsure = false;
          throw markedTransportError();
        }
        return originalApply.call(this, options);
      });
      restoreMigrationApply = () => migrationSpy.mockRestore();
    }

    const context = new ServiceContext({
      hosts: ["https://tinycloud.test"],
      invoke: (_session, service, path, action) => ({
        "x-test-service": service,
        "x-test-path": path,
        "x-test-action": action,
      }),
      fetch: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        if (headers["x-test-service"] === "sql") {
          if (nextSqlIsEnsure) {
            ensureAttempts += 1;
            nextSqlIsEnsure = false;
          }
          if (failure === "403") return new Response("Forbidden", { status: 403 });
          throw failure === "marked-transport" ? markedTransportError() : new Error("transient SQL transport failure");
        }
        if (headers["x-test-service"] === "kv") {
          if (headers["x-test-action"] === "tinycloud.kv/put") {
            registryWrites += 1;
            if (failure === "registry-500") {
              nextSqlIsEnsure = true;
              return new Response("registry transient", { status: 500 });
            }
            writtenKeys.push(headers["x-test-path"]!);
          }
          return new Response(null, { status: 200 });
        }
        if (headers["x-test-service"] === "space") {
          spaceLists += 1;
          return Response.json([]);
        }
        throw new Error("Unexpected registry invocation");
      },
    });
    context.setSession({
      delegationHeader: { Authorization: "test-session" },
      delegationCid: "test-cid",
      spaceId: SPACE_URI,
      verificationMethod: "did:key:default",
      jwk: {},
    });
    Reflect.set(node, "_serviceContext", context);
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnSpy = mock((..._args: unknown[]) => {});
    globalThis.fetch = (async () => {
      activations += 1;
      return Response.json({});
    }) as typeof fetch;
    console.warn = warnSpy;
    try {
      internals.scheduleAccountRegistrySync();
      await internals.pendingAccountRegistrySync?.promise;
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
    expect(activations).toBeGreaterThan(0);
    return { ensureAttempts, writtenKeys, spaceLists, registryWrites, warnSpy };
  }

  test.each(["403", "transient"] as const)(
    "SQL index %s failure cannot block canonical registry records",
    async (failure) => {
      const { writtenKeys, ensureAttempts, spaceLists, registryWrites, warnSpy } = await runRealIndexSync(failure);
      expect({ writtenKeys, ensureAttempts, spaceLists, registryWrites }).toEqual({
        writtenKeys: ["applications/com.example.registry"],
        ensureAttempts: 1,
        spaceLists: 1,
        registryWrites: 1,
      });
      expect(warnedWith(warnSpy, "failed after retries")).toBe(false);
      expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
      const warnings = indexWarnings(warnSpy);
      expect(warnings).toHaveLength(1);
      expect(authorizationVerdictOf(warnings[0]?.[1])).toBe(failure === "403" ? "forbidden" : undefined);
    },
  );

  test("a rejected SQL migration ensure is best-effort and does not reveal its error", async () => {
    const { writtenKeys, ensureAttempts, spaceLists, warnSpy } = await runRealIndexSync("throwing-ensure");
    expect({ writtenKeys, ensureAttempts, spaceLists }).toEqual({
      writtenKeys: ["applications/com.example.registry"], ensureAttempts: 1, spaceLists: 1,
    });
    const warnings = indexWarnings(warnSpy);
    expect(warnings).toHaveLength(1);
    expect(warnSpy.mock.calls.flatMap((args) => args.map((arg) => inspect(arg, { depth: Infinity, showHidden: true })))
      .some((text) => text.includes(INDEX_MARKER))).toBe(false);
  });

  test("an index failure warns once across retries of a failed canonical write", async () => {
    const { ensureAttempts, registryWrites, writtenKeys, spaceLists, warnSpy } = await runRealIndexSync("registry-500");
    expect({ ensureAttempts, registryWrites, writtenKeys, spaceLists }).toEqual({
      ensureAttempts: 3, registryWrites: 3, writtenKeys: [], spaceLists: 0,
    });
    expect(indexWarnings(warnSpy)).toHaveLength(1);
    expect(warnedWith(warnSpy, "failed after retries")).toBe(true);
  }, 10_000);

  test("a transport exception's hidden properties never enter the index warning", async () => {
    const { writtenKeys, ensureAttempts, spaceLists, warnSpy } = await runRealIndexSync("marked-transport");
    expect({ writtenKeys, ensureAttempts, spaceLists }).toEqual({
      writtenKeys: ["applications/com.example.registry"], ensureAttempts: 1, spaceLists: 1,
    });
    const warnings = indexWarnings(warnSpy);
    expect(warnings).toHaveLength(1);
    expect(warnSpy.mock.calls.flatMap((args) => args.map((arg) => inspect(arg, { depth: Infinity, showHidden: true })))
      .some((text) => text.includes(INDEX_MARKER))).toBe(false);
  });

  /** The private registry-sync surface these tests drive (test seam). */
  type RegistrySyncInternals = {
    _address?: string;
    _account: unknown;
    auth: {
      capabilityRequest?: unknown;
      hostOwnedSpaceResult?: (spaceId: string) => Promise<SpaceHostResult>;
    };
    scheduleAccountRegistrySync(): void;
    pendingAccountRegistrySync?: { promise: Promise<void> };
  };

  /**
   * Run the real `scheduleAccountRegistrySync` chain with the failure injected
   * at `wrapper`. Reports how many times the failing request hit the wire and
   * what warned.
   */
  async function runRegistrySync(
    wrapper: Wrapper,
    status: number,
    body: string,
  ): Promise<{ failingCalls: number; warnSpy: Mock<(...args: unknown[]) => void> }> {
    const internals = makeNode({ hasSiwe: false }).node as unknown as RegistrySyncInternals;
    let failingCalls = 0;
    const failingResponse = async () => {
      failingCalls += 1;
      return new Response(body, { status });
    };
    const kv = new KVService({});
    kv.initialize(new ServiceContext({
      hosts: ["https://tinycloud.test"],
      session: {
        delegationHeader: { Authorization: "Bearer session" },
        delegationCid: "bafy-session",
        spaceId: SPACE_URI,
        verificationMethod: "did:key:default",
        jwk: {},
      },
      invoke: () => ({ Authorization: "Bearer signed-invocation" }),
      fetch: failingResponse,
    }));

    if (wrapper === "index.ensure") {
      const sql = new SQLService();
      sql.initialize(new ServiceContext({
        hosts: ["https://tinycloud.test"],
        session: {
          delegationHeader: { Authorization: "Bearer session" },
          delegationCid: "bafy-session",
          spaceId: SPACE_URI,
          verificationMethod: "did:key:default",
          jwk: {},
        },
        invoke: () => ({ Authorization: "Bearer signed-invocation" }),
        fetch: failingResponse,
      }));
      internals._account = new AccountService({
        getDid: () => `did:pkh:eip155:1:${ADDRESS}`,
        getHost: () => "https://tinycloud.test",
        getPrimarySpaceId: () => SPACE_URI,
        getAccountSpaceId: () => `tinycloud:pkh:eip155:1:${ADDRESS}:account`,
        getSpaces: () => ({ list: async () => ({ ok: true, data: [] }) }) as unknown as ISpaceService,
        getAccountDb: () => sql.db("account"),
      });
    } else if (wrapper === "spaces.syncAccessible") {
      internals._account = {
        index: { ensure: async () => ({ ok: true, data: undefined }) },
        spaces: { syncAccessible: () => kv.put("spaces/record", { ok: true }) },
      };
    } else {
      const accountSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;
      internals._address = ADDRESS;
      internals.auth.capabilityRequest = composeManifestRequest([MANIFEST]);
      internals.auth.hostOwnedSpaceResult = () =>
        submitHostDelegation("https://tinycloud.test", { Authorization: HOST_DELEGATION_AUTHORIZATION });
      // Real account service: register → accountErr → the node's wrapper.
      const account = new AccountService({
        getDid: () => `did:pkh:eip155:1:${ADDRESS}`,
        getHost: () => "https://tinycloud.test",
        getPrimarySpaceId: () => SPACE_URI,
        getAccountSpaceId: () => accountSpaceId,
        // Only `applications.register` reaches the KV write; the hosting
        // cases fail before it.
        getSpaces: () => ({ get: () => ({ kv }) }) as unknown as ISpaceService,
      });
      account.index.ensure = async () => ({ ok: true, data: { database: "account" } });
      internals._account = account;
    }

    // Activation and host delegation both POST `/delegate` through the global
    // fetch; the host delegation carries its own Authorization header.
    let activations = 0;
    const delegateFetch = async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      const ok = new Response("{}", { status: 200 });
      if (init?.headers?.Authorization === HOST_DELEGATION_AUTHORIZATION) {
        return wrapper === "owned-space create" ? failingResponse() : ok;
      }
      activations += 1;
      switch (wrapper) {
        case "owned-space activation":
          return failingResponse();
        case "owned-space create":
          return new Response("Space not found", { status: 404 });
        case "post-create activation":
          return activations % 2 === 1 ? new Response("Space not found", { status: 404 }) : failingResponse();
        default:
          return ok;
      }
    };

    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnSpy = mock((..._args: unknown[]) => {});
    globalThis.fetch = delegateFetch as unknown as typeof fetch;
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      internals.scheduleAccountRegistrySync();
      await internals.pendingAccountRegistrySync?.promise;
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
    return { failingCalls, warnSpy };
  }

  /** The error attached to a registry-sync warning. */
  function warnedError(
    warnSpy: Mock<(...args: unknown[]) => void>,
    needle: string,
  ): Error | undefined {
    const call = warnSpy.mock.calls.find((args) => String(args[0] ?? "").includes(needle));
    return call?.[1] instanceof Error ? call[1] : undefined;
  }

  test.each(
    [401, 403, 408, 429, 500].flatMap((status) =>
      AUTH_BODIES.map((body) => ({ status, body })),
    ),
  )("index.ensure $status body=$body warns without retrying", async ({ status, body }) => {
    const { failingCalls, warnSpy } = await runRegistrySync("index.ensure", status, body);
    expect(failingCalls).toBe(1);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
    expect(warnedWith(warnSpy, "failed after retries")).toBe(false);
    const indexWarnings = warnSpy.mock.calls.filter((args) => String(args[0]).includes("account index"));
    expect(indexWarnings).toHaveLength(1);
    expect(authorizationVerdictOf(indexWarnings[0]?.[1])).toBe(
      status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "other",
    );
  });

  test.each(
    WRAPPERS.flatMap((wrapper) =>
      [401, 403].flatMap((status) => AUTH_BODIES.map((body) => ({ wrapper, status, body }))),
    ),
  )("$wrapper $status body=$body stops after one request", async ({ wrapper, status, body }) => {
    const { failingCalls, warnSpy } = await runRegistrySync(wrapper, status, body);

    expect(failingCalls).toBe(1);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(true);
    expect(warnedWith(warnSpy, "failed after retries")).toBe(false);
    // Preserve the producer's human-readable diagnostics while carrying the status.
    const failure = warnedError(warnSpy, "authorization verdict is not retryable");
    expect(failure?.message).toContain(`: ${status}`);
    expect(authorizationVerdictOf(failure)).toBe(status === 401 ? "unauthenticated" : "forbidden");
  });

  test.each([
    [404, "Unauthorized Action: upstream proxy text"],
    [408, "Forbidden"],
    [429, "session expired"],
    [500, "HTTP 401 from another request"],
  ] as const)(
    "non-authorization HTTP %i with deceptive body retries a real spaces registry write",
    async (status, body) => {
      const { failingCalls, warnSpy } = await runRegistrySync("spaces.syncAccessible", status, body);
      expect(failingCalls).toBe(3);
      expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
      const failure = warnedError(warnSpy, "failed after retries");
      expect(failure?.message).toContain(body);
      expect(authorizationVerdictOf(failure)).toBe("other");
    },
    10_000,
  );

  test.each(
    (["applications.register", "owned-space activation", "owned-space create", "post-create activation"] as const)
      .flatMap((wrapper) =>
        ([408, 429, 500] as const).map((status) => ({
          wrapper,
          status,
          body: status === 408 ? "Forbidden" : status === 429 ? "session expired" : "Unauthorized Action: proxy",
        })),
      ),
  )("$wrapper retries HTTP $status despite $body", async ({ wrapper, status, body }) => {
    const { failingCalls, warnSpy } = await runRegistrySync(wrapper, status, body);
    expect(failingCalls).toBe(3);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
    expect(authorizationVerdictOf(warnedError(warnSpy, "failed after retries"))).toBe("other");
  }, 10_000);

  test.each(["applications.register", "owned-space create", "post-create activation"] as const)(
    "%s retries HTTP 404 even when its body reads Unauthorized Action",
    async (wrapper) => {
      const { failingCalls, warnSpy } = await runRegistrySync(wrapper, 404, "Unauthorized Action: proxy");
      expect(failingCalls).toBe(3);
      expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
      expect(authorizationVerdictOf(warnedError(warnSpy, "failed after retries"))).toBe("other");
    },
    10_000,
  );

  test.each(["spaces.syncAccessible", "applications.register"] as const)(
    "%s stops after one write rejected for a full account space",
    async (wrapper) => {
      const { failingCalls, warnSpy } = await runRegistrySync(
        wrapper,
        402,
        "Storage quota exceeded. Used: 1880793 bytes, Limit: 0 bytes",
      );

      expect(failingCalls).toBe(1);
      expect(warnedWith(warnSpy, "storage is full")).toBe(true);
      expect(warnedWith(warnSpy, "failed after retries")).toBe(false);
    },
  );

  test("generic error still retries the full budget (3 attempts)", async () => {
    const { node } = makeNode();
    const task = mock(async () => {
      throw new Error("transient network blip");
    });

    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as any;
    try {
      await (node as any).withAccountRegistryRetry(task, new AbortController().signal);
    } finally {
      console.warn = originalWarn;
    }

    expect(task).toHaveBeenCalledTimes(3);
    expect(warnedWith(warnSpy, "failed after retries")).toBe(true);
    // Generic errors must NOT trip the verdict short-circuit.
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
  }, 10_000);
});
