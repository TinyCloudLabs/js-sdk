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

import { describe, expect, mock, test, type Mock } from "bun:test";

import {
  AccountService,
  KVService,
  ServiceContext,
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

  const syncAccessible = mock(async () => ({ ok: true, data: [] }));
  (node as any)._account = {
    index: { ensure: mock(async () => ({ ok: true, data: undefined })) },
    spaces: { syncAccessible },
  };

  return { node, wasm, syncAccessible };
}

describe("sign-in account registry barrier", () => {
  test("waits for queued registry writes before resolving", async () => {
    const { node } = makeNode();
    const registry = Promise.withResolvers<void>();
    const scheduled = Promise.withResolvers<void>();
    const core = Reflect.get(node, "tc");
    if (core === null || typeof core !== "object") throw new Error("TinyCloud core is unavailable");
    const auth = Reflect.get(node, "auth");
    if (auth === null || typeof auth !== "object") throw new Error("Node authorization is unavailable");
    Reflect.set(auth, "hosts", ["https://tinycloud.test"]);
    Reflect.set(core, "signIn", async () => {});
    Reflect.set(node, "initializeServices", async () => {});
    Reflect.set(node, "registerPrimarySessionGrant", () => {});
    Reflect.set(node, "bootstrapAccountIfNeeded", async () => false);
    Reflect.set(node, "ensureRequestedEncryptionNetworks", async () => {});
    Reflect.set(node, "ensureOwnedSpaceHostedById", async () => {});
    Reflect.set(node, "scheduleAccountRegistrySync", () => {
      Reflect.set(node, "accountRegistryTail", registry.promise);
      scheduled.resolve();
    });

    let settled = false;
    const signIn = node.signIn().then(() => {
      settled = true;
    });
    await scheduled.promise;
    await Promise.resolve();
    expect(settled).toBe(false);

    registry.resolve();
    await signIn;
    expect(settled).toBe(true);
  });
  test("aborts a hung registry request at its real-time deadline before sign-in resolves", async () => {
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
    expect(warnedWith(warnSpy, "deadline exceeded")).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0]?.aborted).toBe(true);
  });

  // Use the real retry delays: a transient registry rejection must warn only
  // after its bounded attempts and must not reject the sign-in promise.
  test("ordinary registry rejection warns and sign-in succeeds", async () => {
    const { node } = makeNode();
    const core = Reflect.get(node, "tc");
    const auth = Reflect.get(node, "auth");
    if (!core || typeof core !== "object" || !auth || typeof auth !== "object") {
      throw new Error("Sign-in dependencies are unavailable");
    }
    Reflect.set(node, "_restoredTcSession", Reflect.get(auth, "tinyCloudSession"));
    Reflect.set(auth, "hosts", ["https://tinycloud.test"]);
    Reflect.set(core, "signIn", async () => {});
    Reflect.set(node, "accountRegistryDeadlineMs", 4_000);
    Reflect.set(node, "_account", {
      index: { ensure: async () => { throw new Error("registry unavailable"); } },
      spaces: { syncAccessible: async () => ({ ok: true, data: [] }) },
    });
    Reflect.set(node, "initializeServices", async () => {});
    Reflect.set(node, "registerPrimarySessionGrant", () => {});
    Reflect.set(node, "bootstrapAccountIfNeeded", async () => false);
    Reflect.set(node, "ensureRequestedEncryptionNetworks", async () => {});
    Reflect.set(node, "ensureOwnedSpaceHostedById", async () => {});

    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      await node.signIn();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnedWith(warnSpy, "failed after retries")).toBe(true);
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
  test("Unauthorized Action error runs the task exactly once (no retry)", async () => {
    const { node } = makeNode();
    const task = mock(async () => {
      throw new Error(
        "Unauthorized Action: tinycloud:pkh:eip155:1:0x0:default/space/ tinycloud.space/list",
      );
    });

    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as any;
    try {
      await (node as any).withAccountRegistryRetry(task, new AbortController().signal);
    } finally {
      console.warn = originalWarn;
    }

    expect(task).toHaveBeenCalledTimes(1);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(true);
  });

  test("401-shaped error runs the task exactly once (no retry)", async () => {
    const { node } = makeNode();
    const task = mock(async () => {
      throw new Error("request failed: 401");
    });

    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as any;
    try {
      await (node as any).withAccountRegistryRetry(task, new AbortController().signal);
    } finally {
      console.warn = originalWarn;
    }

    expect(task).toHaveBeenCalledTimes(1);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(true);
  });

  const AUTH_BODIES = [
    "",
    "Unauthorized Action: tinycloud:pkh:eip155:1:0x0:account/kv/applications/ tinycloud.kv/put",
    "Forbidden",
    "session expired",
  ];
  /**
   * Where the 401/403 is injected:
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

    if (wrapper === "spaces.syncAccessible") {
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
      internals._account = new AccountService({
        getDid: () => `did:pkh:eip155:1:${ADDRESS}`,
        getHost: () => "https://tinycloud.test",
        getPrimarySpaceId: () => SPACE_URI,
        getAccountSpaceId: () => accountSpaceId,
        // Only `applications.register` reaches the KV write; the hosting
        // cases fail before it.
        getSpaces: () => ({ get: () => ({ kv }) }) as unknown as ISpaceService,
      });
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

  /** The message of the error passed with the "not retryable" warning. */
  function stoppedErrorMessage(warnSpy: Mock<(...args: unknown[]) => void>): string | undefined {
    const call = warnSpy.mock.calls.find((args) =>
      String(args[0] ?? "").includes("authorization verdict is not retryable"),
    );
    return call?.[1] instanceof Error ? call[1].message : undefined;
  }

  test.each(
    WRAPPERS.flatMap((wrapper) =>
      [401, 403].flatMap((status) => AUTH_BODIES.map((body) => ({ wrapper, status, body }))),
    ),
  )("$wrapper $status body=$body stops after one request", async ({ wrapper, status, body }) => {
    const { failingCalls, warnSpy } = await runRegistrySync(wrapper, status, body);

    expect(failingCalls).toBe(1);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(true);
    expect(warnedWith(warnSpy, "failed after retries")).toBe(false);
    // The wrapper's message keeps the HTTP status for diagnostics.
    expect(stoppedErrorMessage(warnSpy)).toContain(`: ${status}`);
  });

  test("typed non-authorization status retries even when the body reads Unauthorized Action", async () => {
    const { failingCalls, warnSpy } = await runRegistrySync(
      "spaces.syncAccessible",
      500,
      "Unauthorized Action: upstream proxy text",
    );

    expect(failingCalls).toBe(3);
    expect(warnedWith(warnSpy, "failed after retries")).toBe(true);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
  }, 10_000);

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
