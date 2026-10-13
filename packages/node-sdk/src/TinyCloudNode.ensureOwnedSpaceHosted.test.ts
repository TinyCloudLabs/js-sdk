import { expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const SECRETS = `tinycloud:pkh:eip155:1:${ADDRESS}:secrets`;

function makeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function makeWasmBindings(): IWasmBindings {
  return {
    invoke: async () => undefined,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    createSessionManager: makeSessionManager,
  } as unknown as IWasmBindings;
}

function makeNode(): TinyCloudNode {
  const signer = {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
    signMessage: mock(async () => "0xsig"),
  };
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: signer as any,
    wasmBindings: makeWasmBindings(),
  });
  // Simulate post-signIn state.
  (node as any)._address = ADDRESS;
  (node as any)._chainId = 1;
  (node as any).auth = {
    tinyCloudSession: {
      address: ADDRESS,
      chainId: 1,
      delegationHeader: { Authorization: "base-token" },
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
    },
    hostOwnedSpaceResult: mock(async () => ({ success: true, status: 200 })),
  };
  return node;
}

/**
 * Override the account registry so `ensureOwnedSpaceHosted`'s registry check
 * (`account.index.spaces.list()` fast path, then canonical
 * `account.spaces.get(spaceId)`) returns a deterministic result. `register` is
 * a no-op spy so the post-host durable write does not blow up.
 */
function stubAccountRegistry(
  node: TinyCloudNode,
  opts: {
    indexList?: ReturnType<typeof mock>;
    get?: ReturnType<typeof mock>;
    register?: ReturnType<typeof mock>;
  },
): void {
  const indexList =
    opts.indexList ?? mock(async () => ({ ok: true as const, data: [] }));
  const get =
    opts.get ??
    mock(async () => ({
      ok: false as const,
      error: { code: "KV_NOT_FOUND", message: "Key not found", service: "kv" },
    }));
  (node as any)._account = {
    index: { spaces: { list: indexList } },
    spaces: {
      get,
      register:
        opts.register ?? mock(async () => ({ ok: true as const, data: {} })),
    },
  };
}

function withFetch<T>(
  impl: (input: RequestInfo | URL) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

/**
 * The node's answer to a repeat POST of an already stored delegation: empty
 * lists. Only the sign-in activation (the first POST) lists hosted spaces.
 */
async function repeatActivation(): Promise<Response> {
  return Response.json({ activated: [], skipped: [] });
}

/** Mark SECRETS hosted the way sign-in does from its activation's `activated` list. */
function signInActivated(node: TinyCloudNode): void {
  (Reflect.get(node, "hostedOwnedSpaceIds") as Set<string>).add(SECRETS);
}

/** Let pending fetches and promise chains run. */
async function nextTasks(): Promise<void> {
  for (let hop = 0; hop < 5; hop += 1) {
    const nextTask = Promise.withResolvers<void>();
    setImmediate(nextTask.resolve);
    await nextTask.promise;
  }
}

test("ensureOwnedSpaceHosted does NOT host when the SQLite index already lists the space", async () => {
  const node = makeNode();
  const indexList = mock(async () => ({
    ok: true as const,
    data: [
      { spaceId: SECRETS, name: "secrets", ownerDid: "", type: "owned", permissions: ["*"], status: "active" },
    ],
  }));
  const get = mock(async () => ({ ok: true as const, data: {} }));
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  // Index hit => no host-SIWE prompt; canonical KV read not even needed.
  expect(hostOwnedSpace).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

test("ensureOwnedSpaceHosted does NOT host when the canonical KV record exists (index empty)", async () => {
  const node = makeNode();
  // Index has no rows; canonical `account/spaces/{id}` KV record is present.
  const indexList = mock(async () => ({ ok: true as const, data: [] }));
  const get = mock(async () => ({ ok: true as const, data: {} }));
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  expect(hostOwnedSpace).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(1);
});

test("ensureOwnedSpaceHosted hosts when neither index nor canonical KV lists the space", async () => {
  const node = makeNode();
  const indexList = mock(async () => ({ ok: true as const, data: [] }));
  const get = mock(async () => ({
    ok: false as const,
    error: { code: "KV_NOT_FOUND", message: "Key not found", service: "kv" },
  }));
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  expect(hostOwnedSpace).toHaveBeenCalledTimes(1);
  expect(hostOwnedSpace).toHaveBeenCalledWith("secrets");
});

test("TC-473: ensureOwnedSpaceHosted issues one registry write after hosting", async () => {
  const node = makeNode();
  const register = mock(async () => ({ ok: true as const, data: {} }));
  stubAccountRegistry(node, {
    indexList: mock(async () => ({ ok: true as const, data: [] })),
    get: mock(async () => ({
      ok: false as const,
      error: { code: "KV_NOT_FOUND", message: "Key not found", service: "kv" },
    })),
    register,
  });
  const hostOwnedSpaceResult = mock(async () => ({ success: true, status: 200 }));
  Reflect.set(Reflect.get(node, "auth"), "hostOwnedSpaceResult", hostOwnedSpaceResult);

  const spaceId = await withFetch(repeatActivation, () => node.ensureOwnedSpaceHosted("secrets"));

  expect(spaceId).toBe(SECRETS);
  expect(hostOwnedSpaceResult).toHaveBeenCalledTimes(1);
  expect(hostOwnedSpaceResult).toHaveBeenCalledWith(SECRETS, undefined, expect.any(AbortSignal));
  expect(register).toHaveBeenCalledTimes(1);
});

test("TC-998: a registered space resolves while the background registry sync is still running", async () => {
  const node = makeNode();
  const get = mock(async () => ({ ok: true as const, data: {} }));
  stubAccountRegistry(node, { get });
  const hostOwnedSpace = mock(async () => SECRETS);
  Reflect.set(node, "hostOwnedSpace", hostOwnedSpace);
  const backgroundSync = Promise.withResolvers<void>();
  Reflect.set(node, "accountRegistryTail", backgroundSync.promise);

  expect(await node.ensureOwnedSpaceHosted("secrets")).toBe(SECRETS);
  expect(hostOwnedSpace).not.toHaveBeenCalled();
  backgroundSync.resolve();
});

for (const [label, registry] of [
  ["404s", { get: mock(async () => ({ ok: false as const, error: { code: "NOT_FOUND", message: "Space not found", service: "kv" } })) }],
  ["throws", {
    indexList: mock(async () => {
      throw new Error("no such table: spaces");
    }),
    get: mock(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    }),
  }],
] as const) {
  test(`TC-994: a space the sign-in activation reported hosted is not re-hosted when its registry read ${label}`, async () => {
    const node = makeNode();
    stubAccountRegistry(node, registry);
    const hostOwnedSpaceResult = mock(async () => ({ success: true, status: 200 }));
    Reflect.set(Reflect.get(node, "auth"), "hostOwnedSpaceResult", hostOwnedSpaceResult);
    signInActivated(node);

    const spaceId = await withFetch(repeatActivation, () => node.ensureOwnedSpaceHosted("secrets"));

    expect(spaceId).toBe(SECRETS);
    expect(hostOwnedSpaceResult).not.toHaveBeenCalled();
    // Known hosted: the slow registry read is skipped entirely.
    expect(registry.get).not.toHaveBeenCalled();
  });
}

test("TC-994: concurrent callers share one host approval, and a later call in the session asks for none", async () => {
  const node = makeNode();
  stubAccountRegistry(node, {});
  const approval = Promise.withResolvers<{ success: true; status: number }>();
  const hostOwnedSpaceResult = mock(() => approval.promise);
  Reflect.set(Reflect.get(node, "auth"), "hostOwnedSpaceResult", hostOwnedSpaceResult);

  const [first, second, later] = await withFetch(repeatActivation, async () => {
    // e.g. the background registry sync and the app hosting the same space.
    const pending = [node.ensureOwnedSpaceHosted("secrets"), node.ensureOwnedSpaceHosted("secrets")];
    await nextTasks();
    approval.resolve({ success: true, status: 200 });
    const settled = await Promise.all(pending);
    return [...settled, await node.ensureOwnedSpaceHosted("secrets")];
  });

  expect([first, second, later]).toEqual([SECRETS, SECRETS, SECRETS]);
  expect(hostOwnedSpaceResult).toHaveBeenCalledTimes(1);
});

test("TC-998: a registry sync joining an app's in-flight host stops waiting when it is aborted", async () => {
  const node = makeNode();
  stubAccountRegistry(node, {});
  const approval = Promise.withResolvers<{ success: true; status: number }>();
  const hostOwnedSpaceResult = mock(() => approval.promise);
  Reflect.set(Reflect.get(node, "auth"), "hostOwnedSpaceResult", hostOwnedSpaceResult);
  let hosted = false;
  const activation = async () =>
    Response.json(hosted ? { activated: [], skipped: [] } : { activated: [], skipped: [SECRETS] });

  await withFetch(activation, async () => {
    const app = node.ensureOwnedSpaceHosted("secrets");
    await nextTasks();
    const registry = new AbortController();
    const sync = (Reflect.get(node, "ensureOwnedSpaceHostedById") as (id: string, signal: AbortSignal) => Promise<void>)
      .call(node, SECRETS, registry.signal);
    const syncOutcome = sync.then(() => "settled", () => "aborted");
    await nextTasks();
    registry.abort(new DOMException("Account registry deadline exceeded", "TimeoutError"));
    expect(await syncOutcome).toBe("aborted");

    // The app's approval is still open and still completes for the app.
    hosted = true;
    approval.resolve({ success: true, status: 200 });
    expect(await app).toBe(SECRETS);
  });
  expect(hostOwnedSpaceResult).toHaveBeenCalledTimes(1);
});

test("TC-998: a host only the registry sync waits for is cancelled when the sync is aborted", async () => {
  const node = makeNode();
  const hostSignals: AbortSignal[] = [];
  const approval = Promise.withResolvers<{ success: true; status: number }>();
  const hostOwnedSpaceResult = mock((_spaceId: string, _purpose: unknown, signal: AbortSignal) => {
    hostSignals.push(signal);
    return approval.promise;
  });
  Reflect.set(Reflect.get(node, "auth"), "hostOwnedSpaceResult", hostOwnedSpaceResult);
  const registry = new AbortController();

  await withFetch(async () => Response.json({ activated: [], skipped: [SECRETS] }), async () => {
    const sync = (Reflect.get(node, "ensureOwnedSpaceHostedById") as (id: string, signal: AbortSignal) => Promise<void>)
      .call(node, SECRETS, registry.signal)
      .then(() => "settled", () => "aborted");
    await nextTasks();
    expect(hostSignals).toHaveLength(1);
    expect(hostSignals[0]?.aborted).toBe(false);

    registry.abort(new DOMException("Account registry deadline exceeded", "TimeoutError"));
    expect(await sync).toBe("aborted");
    // No caller is left, so the host request itself is cancelled and a late approval is discarded.
    expect(hostSignals[0]?.aborted).toBe(true);
    approval.resolve({ success: true, status: 200 });
  });
});

test("TC-998: a registry sync aborted just before hosting opens no approval and leaves nothing unhandled", async () => {
  const node = makeNode();
  const hostOwnedSpaceResult = mock(async () => {
    throw new Error("wallet rejected");
  });
  Reflect.set(Reflect.get(node, "auth"), "hostOwnedSpaceResult", hostOwnedSpaceResult);
  const registry = new AbortController();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    // The hang guard fires while the activation probe is answering "skipped".
    const outcome = await withFetch(async () => {
      registry.abort(new DOMException("Account registry deadline exceeded", "TimeoutError"));
      return Response.json({ activated: [], skipped: [SECRETS] });
    }, () =>
      (Reflect.get(node, "ensureOwnedSpaceHostedById") as (id: string, signal: AbortSignal) => Promise<void>)
        .call(node, SECRETS, registry.signal)
        .then(() => "settled", (error: unknown) => (error instanceof DOMException ? error.name : "other")));
    await nextTasks();

    expect(outcome).toBe("TimeoutError");
    expect(hostOwnedSpaceResult).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("TC-998: an unhosted space is hosted without waiting for the background sync; its registry write queues behind it", async () => {
  const node = makeNode();
  const order: string[] = [];
  const register = mock(async () => {
    order.push("register");
    return { ok: true as const, data: {} };
  });
  stubAccountRegistry(node, { register });
  const hostOwnedSpaceResult = mock(async () => {
    order.push("host");
    return { success: true, status: 200 };
  });
  Reflect.set(Reflect.get(node, "auth"), "hostOwnedSpaceResult", hostOwnedSpaceResult);
  const backgroundSync = Promise.withResolvers<void>();
  Reflect.set(node, "accountRegistryTail", backgroundSync.promise.then(() => {
    order.push("background sync");
  }));

  const spaceId = await withFetch(repeatActivation, async () => {
    const ensured = node.ensureOwnedSpaceHosted("secrets");
    await nextTasks();
    expect(order).toEqual(["host"]);
    backgroundSync.resolve();
    return ensured;
  });

  expect(spaceId).toBe(SECRETS);
  expect(order).toEqual(["host", "background sync", "register"]);
  expect(register).toHaveBeenCalledTimes(1);
});

test("ensureOwnedSpaceHosted falls back to canonical KV when the index THROWS (no such table: spaces)", async () => {
  const node = makeNode();
  // Cold SQLite index surfaces `no such table: spaces` as a throw.
  const indexList = mock(async () => {
    throw new Error("no such table: spaces");
  });
  // Canonical KV record exists => still no host.
  const get = mock(async () => ({ ok: true as const, data: {} }));
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  // The cache error must NOT throw; canonical KV hit avoided the host.
  expect(hostOwnedSpace).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(1);
});

test("ensureOwnedSpaceHosted hosts (does not throw) when the entire registry check THROWS", async () => {
  const node = makeNode();
  const indexList = mock(async () => {
    throw new Error("no such table: spaces");
  });
  const get = mock(async () => {
    throw new Error("kv exploded");
  });
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  // Must not throw the cache/KV error: falls through to hosting.
  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  expect(hostOwnedSpace).toHaveBeenCalledTimes(1);
});

test("ensureOwnedSpaceHosted throws when not signed in", async () => {
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => 1,
      signMessage: async () => "0xsig",
    } as any,
    wasmBindings: makeWasmBindings(),
  });
  await expect(node.ensureOwnedSpaceHosted("secrets")).rejects.toThrow(
    "Not signed in",
  );
});
