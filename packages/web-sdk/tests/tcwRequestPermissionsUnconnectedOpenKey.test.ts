/*
 * TC-2281. A restored session, with the app NOT having called `openkey.connect()`, then `requestPermissions(...)`:
 * 3.8.0 refused after the SDK modal with "grantRuntimePermissions requires wallet mode with a signer or privateKey." and made no
 * OpenKey call. 3.9.0-beta opened an OpenKey sign popup that hangs on "Please connect first to sign messages." until it is closed,
 * because `runtimeMessageSigner()` handed the OpenKey client's `signMessage` to the node whenever the client existed.
 *
 * The OpenKey client is used for a runtime grant only with no positive evidence that it is NOT connected: a bound runtime signer, or
 * a session this instance established through the client, or a client whose in-memory `lastAuth` is set (its `connect()` ran), or a
 * client that exposes no `lastAuth` at all (a shape this SDK does not know: today's behaviour). `@openkey/sdk` 0.12.2 declares
 * `lastAuth = null`, sets it in `connect()` and clears it in `signOut()`; 0.9.0 declares it and sets it in `connect()` but has no `signOut`.
 * `getSessionToken()` always answers null in 0.12.2 and `isConnected()` reads the OpenKey cookie, so neither says whether `connect()`
 * ran on this client. The tests that use the "real OpenKey class" run against the hoisted 0.9.0 (the version `apps/openkey-vite` pins),
 * not 0.12.2: web-sdk has no `@openkey/sdk` devDependency.
 */
import "./support/browserGlobalsShim";
import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { RuntimePermissionGrantOptions } from "@tinycloud/node-sdk/core";
import { OpenKey } from "@openkey/sdk";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

const ALICE = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
const MANIFEST = { app_id: "com.test.app", name: "Test App", icon: "https://example.com/icon.png", permissions: [] };
const ENTRY: PermissionEntry = { service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] };
const SIWE = "prepared-siwe";
const NODE_REFUSAL = "grantRuntimePermissions requires wallet mode with a signer or privateKey.";
const CONNECTED = { address: ALICE, keyId: "key-1", keyType: "MANAGED" };

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string): void { this.items.delete(key); }
  setItem(key: string, value: string): void { this.items.set(key, value); }
}

/** A node whose grant behaves like the real one: the caller's `signMessage`, else the node's own signer, else the 3.8.0 refusal. */
function stubNode(options: { signer?: boolean } = {}) {
  const signerSign = mock(async (_message: string) => "0xwallet");
  const signatures: string[] = [];
  const node: Record<string, unknown> = {
    address: ALICE,
    isSessionOnly: false,
    spaceId: "space-1",
    session: { address: ALICE, chainId: 1, sessionKey: "k", siwe: "s", signature: "g" },
    signer: options.signer ? { signMessage: signerSign } : undefined,
    hasRuntimePermissions: () => false,
    getRuntimePermissionDelegations: () => [],
    signInWithOpenKey: mock(async () => undefined),
    signInWithPreparedOpenKey: mock(async () => undefined),
    restoreSession: mock(async () => ({ status: "missing" })),
    signOut: mock(async () => undefined),
  };
  node.grantRuntimePermissions = mock(async (_entries: PermissionEntry[], grant?: RuntimePermissionGrantOptions) => {
    if (grant?.signMessage === undefined && node.signer === undefined) throw new Error(NODE_REFUSAL);
    signatures.push(await (grant?.signMessage ?? signerSign)(SIWE));
    return [];
  });
  return { node, signerSign, signatures };
}

const HOOKS = { showModal: async () => ({ approved: true }) };

/** A fake OpenKey client shaped like the real class: `lastAuth` is null until `connect()` sets it. */
function fakeClient(lastAuth?: unknown | "absent") {
  const signMessage = mock(async (_request: { message: string }, _opts?: { mode?: string }) => ({ signature: "0xopenkey" }));
  const client: Record<string, unknown> = { authorizeTinyCloud: mock(), signMessage };
  if (lastAuth !== "absent") client.lastAuth = lastAuth ?? null;
  return { client, signMessage };
}

/** An instance made from the prototype: no constructor, so no WASM init. It stands for a restored page that never connected anything. */
function restored(stub: ReturnType<typeof stubNode>, config: Record<string, unknown>): TinyCloudWebType {
  const tcw = Object.create(TinyCloudWeb.prototype) as TinyCloudWebType;
  Object.assign(tcw, { session: () => undefined, config, signOutCount: 0, signOutInFlight: 0, _manifest: MANIFEST, _node: stub.node, _testHooks: HOOKS });
  return tcw;
}

describe("restored instance, requestPermissions before the OpenKey client is connected (TC-2281)", () => {
  test("restored instance, OpenKey client never connected: requestPermissions rejects with the 3.8.0 error and the client is never asked to sign", async () => {
    const stub = stubNode();
    const { client, signMessage } = fakeClient(null);
    const tcw = restored(stub, { openkey: { client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow(NODE_REFUSAL);

    expect(signMessage).not.toHaveBeenCalled();
    expect(stub.signatures).toEqual([]);
  });

  test("restored instance, OpenKey client never connected, popup mode and iframe mode alike: zero sign requests", async () => {
    for (const mode of ["popup", "iframe", "redirect", undefined]) {
      const stub = stubNode();
      const { client, signMessage } = fakeClient(null);
      const tcw = restored(stub, { openkey: { client, ...(mode ? { mode } : {}) } });
      await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow(NODE_REFUSAL);
      expect([mode, signMessage.mock.calls.length]).toEqual([mode, 0]);
    }
  });

  test("the REAL OpenKey class from @openkey/sdk: new OpenKey() starts with lastAuth null and no network call, and an unconnected one is never asked to sign", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("{}")) as unknown as typeof fetch);
    try {
      const client = new OpenKey({ host: "https://openkey.example", appName: "test" } as never);
      expect((client as unknown as { lastAuth: unknown }).lastAuth).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      const sign = spyOn(client, "signMessage").mockImplementation((async () => ({ signature: "0xreal" })) as never);
      const stub = stubNode();
      const tcw = restored(stub, { openkey: { client } });

      await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow(NODE_REFUSAL);

      expect(sign).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("restored instance, OpenKey client never connected, but the node has its own signer (wallet mode): the grant signs with that signer, not the client", async () => {
    const stub = stubNode({ signer: true });
    const { client, signMessage } = fakeClient(null);
    const tcw = restored(stub, { openkey: { client } });

    const result = await tcw.requestPermissions([ENTRY]);

    expect(result.approved).toBe(true);
    expect(signMessage).not.toHaveBeenCalled();
    expect(stub.signatures).toEqual(["0xwallet"]);
  });
});

describe("a connected OpenKey session still signs through the client", () => {
  test("restored + the app connected the client first (lastAuth set): Allow signs through the client exactly once", async () => {
    const stub = stubNode();
    const { client, signMessage } = fakeClient(CONNECTED);
    const tcw = restored(stub, { openkey: { client, mode: "iframe" } });

    const result = await tcw.requestPermissions([ENTRY]);

    expect(result.approved).toBe(true);
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(signMessage).toHaveBeenCalledWith({ message: SIWE }, { mode: "iframe" });
    expect(stub.signatures).toEqual(["0xopenkey"]);
  });

  test("the REAL OpenKey class after connect() has set lastAuth: Allow signs through the client exactly once", async () => {
    const client = new OpenKey({ host: "https://openkey.example", appName: "test" } as never);
    (client as unknown as { lastAuth: unknown }).lastAuth = CONNECTED; // what connect() does with the widget result
    const sign = spyOn(client, "signMessage").mockImplementation((async () => ({ signature: "0xreal" })) as never);
    const stub = stubNode();
    const tcw = restored(stub, { openkey: { client } });

    await tcw.requestPermissions([ENTRY]);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(stub.signatures).toEqual(["0xreal"]);
  });

  test("a client that exposes no lastAuth at all (a shape this SDK does not know) keeps today's behaviour: it signs", async () => {
    const stub = stubNode();
    const { client, signMessage } = fakeClient("absent");
    const tcw = restored(stub, { openkey: { client } });

    await tcw.requestPermissions([ENTRY]);

    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(stub.signatures).toEqual(["0xopenkey"]);
  });

  test("a client whose lastAuth cannot be read (a getter that throws) is not treated as unconnected: it signs", async () => {
    const stub = stubNode();
    const { client, signMessage } = fakeClient("absent");
    Object.defineProperty(client, "lastAuth", { get() { throw new Error("not readable"); }, enumerable: true });
    const tcw = restored(stub, { openkey: { client } });

    await tcw.requestPermissions([ENTRY]);

    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  test("a bound runtime signer wins over an unconnected client, and the client is never asked", async () => {
    const stub = stubNode();
    const { client, signMessage } = fakeClient(null);
    const tcw = restored(stub, { openkey: { client } });
    const signer = { signMessage: mock(async (_siwe: string) => "0xapp") };
    tcw.setRuntimePermissionSigner(signer);

    await tcw.requestPermissions([ENTRY]);

    expect(signer.signMessage).toHaveBeenCalledTimes(1);
    expect(signMessage).not.toHaveBeenCalled();
    expect(stub.signatures).toEqual(["0xapp"]);
  });

  test("wallet mode without any OpenKey client is unchanged: the node's own signer signs", async () => {
    const stub = stubNode({ signer: true });
    const tcw = restored(stub, {});

    await tcw.requestPermissions([ENTRY]);

    expect(stub.signatures).toEqual(["0xwallet"]);
  });
});

describe("a session established through OpenKey in this instance (real signIn / signOut)", () => {
  let tcw: TinyCloudWebType;
  let stub: ReturnType<typeof stubNode>;
  let client: ReturnType<typeof fakeClient>;

  beforeAll(async () => {
    client = fakeClient(null);
    tcw = new TinyCloudWeb({ sessionStorage: new BrowserSessionStorage({ storage: new MemoryStorage() }), ui: false, manifest: MANIFEST, openkey: { client: client.client as never, mode: "iframe" } });
    await (tcw as unknown as Record<string, Promise<unknown>>)._initPromise;
    stub = stubNode();
    const state = tcw as unknown as Record<string, unknown>;
    state._node = stub.node;
    state._initPromise = Promise.resolve();
    state._testHooks = HOOKS;
  });
  afterEach(() => {
    client.signMessage.mockClear();
    stub.signatures.length = 0;
  });

  test("before any sign-in the same unconnected client is refused (the restored page)", async () => {
    await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow(NODE_REFUSAL);
    expect(client.signMessage).not.toHaveBeenCalled();
  });

  test("after signIn() through the OpenKey client, Allow signs through it even though its lastAuth reads null: the session was established with it", async () => {
    await tcw.signIn();
    expect(stub.node.signInWithOpenKey).toHaveBeenCalledTimes(1);

    const result = await tcw.requestPermissions([ENTRY]);

    expect(result.approved).toBe(true);
    expect(client.signMessage).toHaveBeenCalledTimes(1);
    expect(stub.signatures).toEqual(["0xopenkey"]);
  });

  test("a session for another account does not use the flag: the unconnected client is refused", async () => {
    await tcw.signIn();
    stub.node.address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    try {
      await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow(NODE_REFUSAL);
      expect(client.signMessage).not.toHaveBeenCalled();
    } finally {
      stub.node.address = ALICE;
    }
  });

  test("a restore clears the flag: the unconnected client is refused again", async () => {
    await tcw.signIn();
    await tcw.restoreSession().catch(() => undefined);

    await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow(NODE_REFUSAL);

    expect(client.signMessage).not.toHaveBeenCalled();
  });

  test("a new sign-in clears the flag before it starts: if it does not complete, the unconnected client is refused", async () => {
    await tcw.signIn();
    (stub.node.signInWithOpenKey as ReturnType<typeof mock>).mockImplementationOnce(async () => { throw new Error("sign-in failed"); });
    await tcw.signIn().catch(() => undefined);

    await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow(NODE_REFUSAL);

    expect(client.signMessage).not.toHaveBeenCalled();
  });

  test("a prepared OpenKey sign-in that fails also clears the flag at its start (no restore runs on that path)", async () => {
    await tcw.signIn();
    const state = tcw as unknown as Record<string, unknown>;
    state.preparedSignIn = { node: stub.node, request: {}, createdAt: Date.now(), signOuts: state.signOutCount };
    (stub.node.signInWithPreparedOpenKey as ReturnType<typeof mock>).mockImplementationOnce(async () => { throw new Error("prepared sign-in failed"); });
    await tcw.signIn().catch(() => undefined);
    expect(stub.node.signInWithPreparedOpenKey).toHaveBeenCalled();

    await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow(NODE_REFUSAL);

    expect(client.signMessage).not.toHaveBeenCalled();
  });

  test("after signOut() the flag is cleared: the unconnected client is refused again, with zero sign requests", async () => {
    await tcw.signIn();
    expect((await tcw.requestPermissions([ENTRY])).approved).toBe(true);
    expect(client.signMessage).toHaveBeenCalledTimes(1);
    client.signMessage.mockClear();
    stub.signatures.length = 0;

    await tcw.signOut();

    await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow(NODE_REFUSAL);

    expect(client.signMessage).not.toHaveBeenCalled();
  });
});
