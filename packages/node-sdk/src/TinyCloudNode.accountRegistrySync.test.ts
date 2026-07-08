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

import { describe, expect, mock, test } from "bun:test";

import {
  type ISessionManager,
  type IWasmBindings,
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
      await (node as any).withAccountRegistryRetry(task);
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
      await (node as any).withAccountRegistryRetry(task);
    } finally {
      console.warn = originalWarn;
    }

    expect(task).toHaveBeenCalledTimes(1);
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(true);
  });

  test("generic error still retries the full budget (3 attempts)", async () => {
    const { node } = makeNode();
    const task = mock(async () => {
      throw new Error("transient network blip");
    });

    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy as any;
    try {
      await (node as any).withAccountRegistryRetry(task);
    } finally {
      console.warn = originalWarn;
    }

    expect(task).toHaveBeenCalledTimes(3);
    expect(warnedWith(warnSpy, "failed after retries")).toBe(true);
    // Generic errors must NOT trip the verdict short-circuit.
    expect(warnedWith(warnSpy, "authorization verdict is not retryable")).toBe(false);
  }, 10_000);
});
