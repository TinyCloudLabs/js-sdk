/*
 * TC-2281. `requestPermissions(...)` on an OpenKey session signs the runtime grant through the OpenKey client's `signMessage`.
 * That call, made without a `keyId` on a client that was never connected, opens an OpenKey sign dialog with no key; after the user
 * signs in inside it, the dialog dead-ends on "Please connect first to sign messages."
 *
 * The SDK must not depend on OpenKey's own fallback. Every OpenKey sign request from the SDK carries the keyId of the CONNECTED
 * account. When the client is not connected the SDK connects it first (`connect()`, same mode as the sign request). A key that
 * is missing, or that cannot be tied to the session's account, is a typed `OpenKeySigningKeyError`; the SDK never calls
 * `signMessage` without a keyId. What is signed (the SIWE) and which permissions are granted do not change.
 *
 * `@openkey/sdk` 0.12.2 declares `lastAuth = null`, sets it in `connect()` and clears it in `signOut()`; `getSessionToken()` always
 * answers null and `isConnected()` reads the OpenKey cookie, so neither says whether `connect()` ran on this client. The tests that
 * use the "real OpenKey class" run against the hoisted 0.9.0 (the version `apps/openkey-vite` pins), not 0.12.2: web-sdk has no
 * `@openkey/sdk` devDependency.
 */
import "./support/browserGlobalsShim";
import { afterEach, beforeAll, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { RuntimePermissionGrantOptions } from "@tinycloud/node-sdk/core";
import { OpenKey } from "@openkey/sdk";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

const ALICE = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
const BOB = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const MANIFEST = { app_id: "com.test.app", name: "Test App", icon: "https://example.com/icon.png", permissions: [] };
const ENTRY: PermissionEntry = { service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] };
const SIWE = "prepared-siwe";
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

interface StubNode {
  node: Record<string, unknown>;
  signerSign: Mock<(message: string) => Promise<string>>;
  signatures: string[];
  granted: PermissionEntry[][];
}

/** A node whose grant calls the caller's `signMessage` (as the real one does) and records what it was granted. */
function stubNode(options: { signer?: boolean } = {}): StubNode {
  const signerSign = mock(async (_message: string) => "0xwallet");
  const signatures: string[] = [];
  const granted: PermissionEntry[][] = [];
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
  node.grantRuntimePermissions = mock(async (entries: PermissionEntry[], grant?: RuntimePermissionGrantOptions) => {
    if (grant?.signMessage === undefined && node.signer === undefined) throw new Error("no signer");
    signatures.push(await (grant?.signMessage ?? signerSign)(SIWE));
    granted.push(entries);
    return [];
  });
  return { node, signerSign, signatures, granted };
}

const HOOKS = { showModal: async () => ({ approved: true }) };

interface Call {
  fn: "connect" | "signMessage";
  args: unknown[];
}

interface FakeClient {
  client: Record<string, unknown>;
  signMessage: Mock<(...args: unknown[]) => Promise<{ signature: string }>>;
  connect: Mock<(...args: unknown[]) => Promise<unknown>>;
  calls: Call[];
}

/**
 * A fake OpenKey client shaped like the real class: `lastAuth` is null until `connect()` sets it. `connect` resolves
 * `connectResult` (default: the CONNECTED account) and, like the real class, stores it in `lastAuth`.
 */
function fakeClient(
  options: { lastAuth?: unknown | "absent"; connect?: "absent" | unknown | (() => Promise<unknown>) } = {},
): FakeClient {
  const calls: Call[] = [];
  const client: Record<string, unknown> = { authorizeTinyCloud: mock() };
  const signMessage = mock(async (...args: unknown[]) => {
    calls.push({ fn: "signMessage", args });
    return { signature: "0xopenkey" };
  });
  client.signMessage = signMessage;
  if (options.lastAuth !== "absent") client.lastAuth = options.lastAuth ?? null;
  const connect = mock(async (...args: unknown[]) => {
    calls.push({ fn: "connect", args });
    const result = typeof options.connect === "function" ? await (options.connect as () => Promise<unknown>)() : (options.connect ?? CONNECTED);
    if ("lastAuth" in client) try { client.lastAuth = result; } catch { /* a read-only lastAuth, as in the throwing-getter tests */ }
    return result;
  });
  if (options.connect !== "absent") client.connect = connect;
  return { client, signMessage, connect, calls };
}

/** An instance made from the prototype: no constructor, so no WASM init. It stands for a restored page that never connected anything. */
function restored(stub: StubNode, config: Record<string, unknown>): TinyCloudWebType {
  const tcw = Object.create(TinyCloudWeb.prototype) as TinyCloudWebType;
  Object.assign(tcw, { session: () => undefined, config, signOutCount: 0, signOutInFlight: 0, _manifest: MANIFEST, _node: stub.node, _testHooks: HOOKS });
  return tcw;
}

/** Every sign request the SDK made carried a non-empty keyId. */
function signRequests(client: Pick<FakeClient, "signMessage">): Array<{ message: string; keyId?: unknown }> {
  return client.signMessage.mock.calls.map((call) => call[0] as { message: string; keyId?: unknown });
}

describe("the OpenKey client is already connected: its keyId rides on the sign request", () => {
  test("lastAuth set: signMessage gets the connected account's keyId, the same SIWE and the configured mode; no connect()", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: CONNECTED });
    const tcw = restored(stub, { openkey: { client: fake.client, mode: "iframe" } });

    const result = await tcw.requestPermissions([ENTRY]);

    expect(result.approved).toBe(true);
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.signMessage).toHaveBeenCalledTimes(1);
    expect(fake.signMessage).toHaveBeenCalledWith({ message: SIWE, keyId: "key-1" }, { mode: "iframe" });
    expect(stub.signatures).toEqual(["0xopenkey"]);
    expect(stub.granted).toEqual([[ENTRY]]);
  });

  test("the REAL OpenKey class after connect() has set lastAuth: signMessage gets its keyId", async () => {
    const client = new OpenKey({ host: "https://openkey.example", appName: "test" } as never);
    (client as unknown as { lastAuth: unknown }).lastAuth = CONNECTED; // what connect() does with the widget result
    const sign = spyOn(client, "signMessage").mockImplementation((async () => ({ signature: "0xreal" })) as never);
    const connect = spyOn(client, "connect");
    const stub = stubNode();
    const tcw = restored(stub, { openkey: { client } });

    await tcw.requestPermissions([ENTRY]);

    expect(connect).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith({ message: SIWE, keyId: "key-1" }, { mode: "popup" });
    expect(stub.signatures).toEqual(["0xreal"]);
  });

  test("an external key's keyId is passed as OpenKey reported it", async () => {
    const stub = stubNode();
    const external = { address: ALICE, keyId: `external:${ALICE}`, keyType: "EXTERNAL" };
    const fake = fakeClient({ lastAuth: external });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await tcw.requestPermissions([ENTRY]);

    expect(signRequests(fake)).toEqual([{ message: SIWE, keyId: `external:${ALICE}` }]);
  });

  test("the account match ignores address case", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: { ...CONNECTED, address: ALICE.toLowerCase() } });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await tcw.requestPermissions([ENTRY]);

    expect(signRequests(fake)).toEqual([{ message: SIWE, keyId: "key-1" }]);
  });
});

describe("popup mode, the OpenKey client is not connected: connect, then OPENKEY_CONNECTED_RETRY; the second click signs in one popup", () => {
  // The user needs longer in the connect popup than the click's user activation lasts, so a sign popup right after it is blocked by the browser.
  // Chromium proof: e2e/openkey-runtime-grant.pw.ts.
  test("restored page, lastAuth null: the first Allow connects and rejects with OPENKEY_CONNECTED_RETRY, signing nothing; the second signs with the connected keyId", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: null });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ name: "OpenKeySigningKeyError", code: "OPENKEY_CONNECTED_RETRY" });

    expect(fake.calls.map((call) => call.fn)).toEqual(["connect"]);
    expect(fake.calls[0]!.args).toEqual([{ mode: "popup" }]);
    expect(stub.signatures).toEqual([]);
    expect(stub.granted).toEqual([]);

    const second = await tcw.requestPermissions([ENTRY]);

    expect(second.approved).toBe(true);
    expect(fake.calls.map((call) => call.fn)).toEqual(["connect", "signMessage"]);
    expect(fake.calls[1]!.args).toEqual([{ message: SIWE, keyId: "key-1" }, { mode: "popup" }]);
    expect(stub.signatures).toEqual(["0xopenkey"]);
    expect(stub.granted).toEqual([[ENTRY]]);
  });

  test("the explicit popup mode and the default mode alike; the error says what happened and what to do", async () => {
    for (const mode of ["popup", undefined] as const) {
      const stub = stubNode();
      const fake = fakeClient({ lastAuth: null });
      const tcw = restored(stub, { openkey: { client: fake.client, ...(mode ? { mode } : {}) } });

      const error = await tcw.requestPermissions([ENTRY]).then(() => undefined, (e: unknown) => e as Error & { code?: string });

      expect([mode, error?.name, error?.code]).toEqual([mode, "OpenKeySigningKeyError", "OPENKEY_CONNECTED_RETRY"]);
      expect(error!.message).toBe("OpenKey is now connected; click Allow again to sign");
      expect([mode, fake.signMessage.mock.calls.length]).toEqual([mode, 0]);
    }
  });

  test("the REAL OpenKey class, never connected: connect() runs, no sign request; after connect set lastAuth, the next Allow signs with its keyId", async () => {
    const client = new OpenKey({ host: "https://openkey.example", appName: "test" } as never);
    expect((client as unknown as { lastAuth: unknown }).lastAuth).toBeNull();
    const connect = spyOn(client, "connect").mockImplementation((async () => {
      (client as unknown as { lastAuth: unknown }).lastAuth = CONNECTED;
      return CONNECTED;
    }) as never);
    const sign = spyOn(client, "signMessage").mockImplementation((async () => ({ signature: "0xreal" })) as never);
    const stub = stubNode();
    const tcw = restored(stub, { openkey: { client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ code: "OPENKEY_CONNECTED_RETRY" });
    expect(sign).not.toHaveBeenCalled();

    await tcw.requestPermissions([ENTRY]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith({ message: SIWE, keyId: "key-1" }, { mode: "popup" });
  });

  test("the user cancelling the connect dialog rejects with OpenKey's own error, not the retry error, and no sign request is made", async () => {
    const cancelled = { code: "USER_CANCELLED", message: "closed" };
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: null, connect: async () => { throw cancelled; } });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toBe(cancelled);

    expect(fake.signMessage).not.toHaveBeenCalled();
    expect(stub.signatures).toEqual([]);
  });

  test("a lastAuth getter that throws reads as not connected: the client connects, never signs blind", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: "absent" });
    Object.defineProperty(fake.client, "lastAuth", { get() { throw new Error("not readable"); }, enumerable: true });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ code: "OPENKEY_CONNECTED_RETRY" });

    expect(fake.calls.map((call) => call.fn)).toEqual(["connect"]);
    expect(fake.signMessage).not.toHaveBeenCalled();
  });
});

describe("iframe and redirect mode, the OpenKey client is not connected: connect, then sign in one go", () => {
  test("restored page, lastAuth null: connect() runs before signMessage, in the same mode, and its keyId is the one signed with", async () => {
    for (const mode of ["iframe", "redirect"] as const) {
      const stub = stubNode();
      const fake = fakeClient({ lastAuth: null });
      const tcw = restored(stub, { openkey: { client: fake.client, mode } });

      const result = await tcw.requestPermissions([ENTRY]);

      expect([mode, result.approved]).toEqual([mode, true]);
      expect([mode, fake.calls.map((call) => call.fn)]).toEqual([mode, ["connect", "signMessage"]]);
      expect(fake.calls[0]!.args).toEqual([{ mode }]);
      expect(fake.calls[1]!.args).toEqual([{ message: SIWE, keyId: "key-1" }, { mode }]);
      expect(stub.signatures).toEqual(["0xopenkey"]);
      expect(stub.granted).toEqual([[ENTRY]]);
    }
  });

  test("the REAL OpenKey class, never connected: connect() runs first and signMessage gets the keyId it returned", async () => {
    const client = new OpenKey({ host: "https://openkey.example", appName: "test" } as never);
    const order: string[] = [];
    const connect = spyOn(client, "connect").mockImplementation((async () => {
      order.push("connect");
      (client as unknown as { lastAuth: unknown }).lastAuth = CONNECTED;
      return CONNECTED;
    }) as never);
    const sign = spyOn(client, "signMessage").mockImplementation((async () => {
      order.push("signMessage");
      return { signature: "0xreal" };
    }) as never);
    const stub = stubNode();
    const tcw = restored(stub, { openkey: { client, mode: "iframe" } });

    await tcw.requestPermissions([ENTRY]);

    expect(order).toEqual(["connect", "signMessage"]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith({ message: SIWE, keyId: "key-1" }, { mode: "iframe" });
  });

  test("a client that exposes no lastAuth (a shape this SDK does not know) is connected first too", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: "absent" });
    const tcw = restored(stub, { openkey: { client: fake.client, mode: "iframe" } });

    await tcw.requestPermissions([ENTRY]);

    expect(fake.calls.map((call) => call.fn)).toEqual(["connect", "signMessage"]);
    expect(signRequests(fake)).toEqual([{ message: SIWE, keyId: "key-1" }]);
  });

  test("a lastAuth that carries no keyId is not a connected key: connect() runs", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: { address: ALICE } });
    const tcw = restored(stub, { openkey: { client: fake.client, mode: "iframe" } });

    await tcw.requestPermissions([ENTRY]);

    expect(fake.calls.map((call) => call.fn)).toEqual(["connect", "signMessage"]);
    expect(signRequests(fake)).toEqual([{ message: SIWE, keyId: "key-1" }]);
  });

  test("the node's own signer does not bypass OpenKey: with an OpenKey client configured, the connected key signs", async () => {
    const stub = stubNode({ signer: true });
    const fake = fakeClient({ lastAuth: null });
    const tcw = restored(stub, { openkey: { client: fake.client, mode: "iframe" } });

    await tcw.requestPermissions([ENTRY]);

    expect(fake.calls.map((call) => call.fn)).toEqual(["connect", "signMessage"]);
    expect(stub.signatures).toEqual(["0xopenkey"]);
    expect(stub.signerSign).not.toHaveBeenCalled();
  });

  test("a lastAuth getter that throws reads as not connected: the client connects, then signs with the keyId it returned", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: "absent" });
    Object.defineProperty(fake.client, "lastAuth", { get() { throw new Error("not readable"); }, enumerable: true });
    const tcw = restored(stub, { openkey: { client: fake.client, mode: "iframe" } });

    await tcw.requestPermissions([ENTRY]);

    expect(fake.calls.map((call) => call.fn)).toEqual(["connect", "signMessage"]);
    expect(signRequests(fake)).toEqual([{ message: SIWE, keyId: "key-1" }]);
  });

  test("a session established through OpenKey in this instance whose lastAuth reads null is connected first, not signed blind", async () => {
    const fake = fakeClient({ lastAuth: null });
    const tcw = new TinyCloudWeb({ sessionStorage: new BrowserSessionStorage({ storage: new MemoryStorage() }), ui: false, manifest: MANIFEST, openkey: { client: fake.client as never, mode: "iframe" } });
    await (tcw as unknown as Record<string, Promise<unknown>>)._initPromise;
    const stub = stubNode();
    const state = tcw as unknown as Record<string, unknown>;
    state._node = stub.node;
    state._initPromise = Promise.resolve();
    state._testHooks = HOOKS;

    await tcw.signIn();
    expect(stub.node.signInWithOpenKey).toHaveBeenCalledTimes(1);
    const result = await tcw.requestPermissions([ENTRY]);

    expect(result.approved).toBe(true);
    expect(fake.calls.map((call) => call.fn)).toEqual(["connect", "signMessage"]);
    expect(fake.calls[1]!.args).toEqual([{ message: SIWE, keyId: "key-1" }, { mode: "iframe" }]);
  });
});

describe("a missing or ambiguous key is a typed OpenKeySigningKeyError and never a sign request without a keyId", () => {
  const SIGNING_KEY_ERROR = "OpenKeySigningKeyError";

  test("not connected and the client cannot connect: OPENKEY_KEY_MISSING, no sign request", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: null, connect: "absent" });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ name: SIGNING_KEY_ERROR, code: "OPENKEY_KEY_MISSING" });

    expect(fake.signMessage).not.toHaveBeenCalled();
    expect(stub.signatures).toEqual([]);
  });

  test("connect() answers without a keyId: OPENKEY_KEY_MISSING, no sign request", async () => {
    for (const answer of [{ address: ALICE }, { address: ALICE, keyId: "" }, { address: ALICE, keyId: 7 }, null, undefined]) {
      const stub = stubNode();
      const fake = fakeClient({ lastAuth: null, connect: async () => answer });
      const tcw = restored(stub, { openkey: { client: fake.client } });

      await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ name: SIGNING_KEY_ERROR, code: "OPENKEY_KEY_MISSING" });

      expect([answer, fake.signMessage.mock.calls.length]).toEqual([answer, 0]);
    }
  });

  test("the connected key belongs to another account than the session: OPENKEY_KEY_AMBIGUOUS, no sign request and no new connect", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: { ...CONNECTED, address: BOB } });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ name: SIGNING_KEY_ERROR, code: "OPENKEY_KEY_AMBIGUOUS" });

    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.signMessage).not.toHaveBeenCalled();
  });

  test("connect() answers with another account than the session: OPENKEY_KEY_AMBIGUOUS, no sign request", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: null, connect: { ...CONNECTED, address: BOB } });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ name: SIGNING_KEY_ERROR, code: "OPENKEY_KEY_AMBIGUOUS" });

    expect(fake.signMessage).not.toHaveBeenCalled();
  });

  test("a keyId with no address to tie it to the session's account is ambiguous, not trusted", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: { keyId: "key-1" } });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ name: SIGNING_KEY_ERROR, code: "OPENKEY_KEY_AMBIGUOUS" });

    expect(fake.signMessage).not.toHaveBeenCalled();
  });

  test("the session changes while the connect dialog is open (sign-out, another account, another node, another session): the grant is cancelled, nothing is signed, in every mode", async () => {
    const changes: Record<string, (tcw: TinyCloudWebType, stub: StubNode) => void> = {
      "sign-out": (tcw) => { (tcw as unknown as { signOutCount: number }).signOutCount += 1; },
      "sign-out in flight": (tcw) => { (tcw as unknown as { signOutInFlight: number }).signOutInFlight += 1; },
      "another account": (_tcw, stub) => { stub.node.address = BOB; },
      "another node": (tcw, stub) => { (tcw as unknown as { _node: unknown })._node = { ...stub.node }; },
      "another session object": (_tcw, stub) => { stub.node.session = { ...(stub.node.session as object) }; },
    };
    for (const mode of ["popup", "iframe"] as const) {
      for (const [change, apply] of Object.entries(changes)) {
        const stub = stubNode();
        let tcw!: TinyCloudWebType;
        const fake = fakeClient({ lastAuth: null, connect: async () => { apply(tcw, stub); return CONNECTED; } });
        tcw = restored(stub, { openkey: { client: fake.client, mode } });

        await expect(tcw.requestPermissions([ENTRY]).then(() => "granted")).rejects.toThrow("Permission request cancelled because the signed session changed or signed out.");

        expect([mode, change, fake.signMessage.mock.calls.length, stub.signatures]).toEqual([mode, change, 0, []]);
      }
    }
  });

  test("the account changes while the sign dialog is open: the signature is not used", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: CONNECTED });
    fake.signMessage.mockImplementation(async () => { stub.node.address = BOB; return { signature: "0xopenkey" }; });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toThrow();

    expect(stub.granted).toEqual([]);
  });

  test("the error is an Error with the documented name, code and message", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: null, connect: "absent" });
    const tcw = restored(stub, { openkey: { client: fake.client } });

    const error = await tcw.requestPermissions([ENTRY]).then(() => undefined, (e: unknown) => e as Error & { code?: string });

    expect(error).toBeInstanceOf(Error);
    expect(error!.name).toBe(SIGNING_KEY_ERROR);
    expect(error!.code).toBe("OPENKEY_KEY_MISSING");
    expect(error!.message).toBe("OpenKey has no connected key");
  });
});

describe("what does not change", () => {
  test("a bound runtime signer wins over an unconnected client: no connect, no sign request", async () => {
    const stub = stubNode();
    const fake = fakeClient({ lastAuth: null });
    const tcw = restored(stub, { openkey: { client: fake.client } });
    const signer = { signMessage: mock(async (_siwe: string) => "0xapp") };
    tcw.setRuntimePermissionSigner(signer);

    await tcw.requestPermissions([ENTRY]);

    expect(signer.signMessage).toHaveBeenCalledTimes(1);
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.signMessage).not.toHaveBeenCalled();
    expect(stub.signatures).toEqual(["0xapp"]);
  });

  test("wallet mode without any OpenKey client: the node's own signer signs and OpenKey is not involved", async () => {
    const stub = stubNode({ signer: true });
    const tcw = restored(stub, {});

    await tcw.requestPermissions([ENTRY]);

    expect(stub.signatures).toEqual(["0xwallet"]);
  });

  test("an OpenKey client without signMessage (older SDK) leaves the grant to the node's signer", async () => {
    const stub = stubNode({ signer: true });
    const tcw = restored(stub, { openkey: { client: { authorizeTinyCloud: mock(), connect: mock() } } });

    await tcw.requestPermissions([ENTRY]);

    expect(stub.signatures).toEqual(["0xwallet"]);
  });
});

describe("every sign request across a signIn / signOut lifecycle carries a keyId", () => {
  let tcw: TinyCloudWebType;
  let stub: StubNode;
  let fake: FakeClient;

  beforeAll(async () => {
    fake = fakeClient({ lastAuth: null });
    tcw = new TinyCloudWeb({ sessionStorage: new BrowserSessionStorage({ storage: new MemoryStorage() }), ui: false, manifest: MANIFEST, openkey: { client: fake.client as never, mode: "iframe" } });
    await (tcw as unknown as Record<string, Promise<unknown>>)._initPromise;
    stub = stubNode();
    const state = tcw as unknown as Record<string, unknown>;
    state._node = stub.node;
    state._initPromise = Promise.resolve();
    state._testHooks = HOOKS;
  });
  afterEach(() => {
    fake.signMessage.mockClear();
    fake.connect.mockClear();
    stub.signatures.length = 0;
  });

  test("before sign-in, after sign-in, after signOut: every request names the connected key", async () => {
    await tcw.requestPermissions([ENTRY]);
    expect(fake.signMessage).toHaveBeenCalledTimes(1);

    await tcw.signIn();
    await tcw.requestPermissions([ENTRY]);
    await tcw.signOut();
    await tcw.requestPermissions([ENTRY]);

    const requests = signRequests(fake);
    expect(requests.length).toBe(3);
    expect(requests.every((request) => request.message === SIWE && request.keyId === "key-1")).toBe(true);
  });
});
