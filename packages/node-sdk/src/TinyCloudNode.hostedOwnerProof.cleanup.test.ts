// TC-4082: a failed hosted-owner proof asks the pinned node to retire the exact session it may have delegated to, and a
// refused restore removes only its own stored session. The proof's own failure is always what the caller sees.
import { afterEach, describe, expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";

const DEFAULT_NODE = "https://node.tinycloud.xyz";
const REGISTRY = "https://registry.hosted-owner-cleanup.test";
const HOSTILE = "https://configured.hosted-owner-cleanup.test";
const NODE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const key = "34".repeat(32);
const signer = new PrivateKeySigner(key);
const address = await signer.getAddress();
const applications = `tinycloud:pkh:eip155:1:${address}:applications`;
const original = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
afterEach(() => {
  globalThis.fetch = original;
  AbortSignal.timeout = originalTimeout;
});

const list = [{ service: "tinycloud.kv", path: "notes/", actions: ["get", "list"] }];

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string | undefined;
  /** The signal the caller passed to fetch itself, not the copy a Request makes of it. */
  signal: AbortSignal | undefined;
}

interface Behaviour {
  /** The answer to `/delegate`; may reject (a transport error) or follow the request's signal (a hang). */
  delegate?: (request: Request) => Response | Promise<Response>;
  invoke?: () => Response | Promise<Response>;
  retire?: () => Response | Promise<Response>;
  /** The wallet refuses to sign. */
  cancelSignature?: boolean;
}

function harness(behaviour: Behaviour = {}, storage = new MemorySessionStorage()) {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({
      method: request.method, url: `${url.origin}${url.pathname}`, signal: init?.signal ?? undefined,
      authorization: request.headers.get("authorization") ?? undefined, body: init?.body ? String(init.body) : undefined,
    });
    if (url.origin === REGISTRY) return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
    if (url.origin === DEFAULT_NODE) {
      if (url.pathname === "/info") return Response.json({ nodeId: NODE_DID, protocol: 1, version: "1.26.22", features: [] });
      if (url.pathname === "/delegate") return behaviour.delegate?.(request) ?? Response.json({ activated: [applications], skipped: [] });
      if (url.pathname === "/invoke") return behaviour.invoke?.() ?? Response.json([]);
      if (url.pathname === "/session/retire") return behaviour.retire?.() ?? Response.json({ recorded: true });
    }
    throw new Error(`Unexpected request ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  const node = new TinyCloudNode({
    host: HOSTILE, newUserHost: HOSTILE, tinycloudFallbackHosts: [HOSTILE], tinycloudRegistryUrl: REGISTRY, autoDiscoverLocalNode: false,
    wasmBindings: new NodeWasmBindings(), sessionStorage: storage, requireExistingAccount: true, allowHostedOwnerProof: true,
    autoBootstrapAccount: false, includeAccountRegistryPermissions: false, enablePublicSpace: false,
    signer: {
      getAddress: () => signer.getAddress(),
      getChainId: () => signer.getChainId(),
      signMessage: async (message: string) => {
        if (behaviour.cancelSignature) throw new Error("User rejected the request");
        return signer.signMessage(message);
      },
    },
    manifest: { app_id: "tc4082-notes", name: "Notes", defaults: false, includePublicSpace: false, permissions: list },
  } as ConstructorParameters<typeof TinyCloudNode>[0]);
  const requests = (method: string, path: string) => seen.filter((entry) => entry.method === method && entry.url === `${DEFAULT_NODE}${path}`);
  return { node, seen, storage, requests };
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** The sign-in's failure, settled; a sign-in that succeeded is a test failure. */
async function failureOf(node: TinyCloudNode): Promise<Error> {
  const outcome = await node.signIn().then(() => undefined, (error: unknown) => error);
  if (!(outcome instanceof Error)) throw new Error("The sign-in was expected to fail");
  return outcome;
}

describe("a failed hosted-owner proof after the /delegate was accepted", () => {
  test("asks the pinned node to retire that exact session once, rethrows the proof's failure, stores nothing", async () => {
    const { node, storage, requests } = harness({ invoke: () => new Response("Space not found", { status: 404 }) });
    const failure = await failureOf(node);
    const status = await node.nodeSignOutStatus();
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    const delegate = requests("POST", "/delegate");
    const retire = requests("POST", "/session/retire");
    expect(delegate).toHaveLength(1);
    expect(retire).toHaveLength(1);
    // The retire carries the root delegation the node was given for this very session.
    expect(JSON.parse(retire[0]!.body ?? "{}")).toEqual({ delegations: [delegate[0]!.authorization] });
    expect(retire[0]!.authorization).toBeDefined();
    expect(status?.notConfirmed).toEqual([]);
    expect(status?.confirmed).toEqual([DEFAULT_NODE]);
    expect(storage.exists(address)).toBe(false);
    expect(node.session).toBeUndefined();
  });

  test("a retire that itself fails changes nothing the caller sees and stores nothing", async () => {
    const { node, storage, requests } = harness({
      invoke: () => new Response("Space not found", { status: 404 }),
      retire: () => new Response("nope", { status: 400 }),
    });
    const failure = await failureOf(node);
    const status = await node.nodeSignOutStatus();
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    const [delegate] = requests("POST", "/delegate");
    const retire = requests("POST", "/session/retire");
    expect(retire).toHaveLength(1);
    expect(JSON.parse(retire[0]!.body ?? "{}")).toEqual({ delegations: [delegate!.authorization] });
    expect(status?.confirmed).toEqual([]);
    expect(status?.notConfirmed).toHaveLength(1);
    expect(storage.exists(address)).toBe(false);
    expect(node.session).toBeUndefined();
  });
});

describe("a failed hosted-owner proof when the /delegate outcome is unknown", () => {
  test("a transport error after the send is retired too, and is what the caller sees", async () => {
    const { node, storage, requests } = harness({ delegate: () => Promise.reject(new TypeError("fetch failed")) });
    const failure = await failureOf(node);
    await node.nodeSignOutStatus();
    expect(failure.name).toBe("NodeNotRespondingError");
    const [delegate] = requests("POST", "/delegate");
    const retire = requests("POST", "/session/retire");
    expect(requests("POST", "/delegate")).toHaveLength(1);
    expect(requests("POST", "/invoke")).toHaveLength(0);
    expect(retire).toHaveLength(1);
    expect(JSON.parse(retire[0]!.body ?? "{}")).toEqual({ delegations: [delegate!.authorization] });
    expect(storage.exists(address)).toBe(false);
    expect(node.session).toBeUndefined();
  });

  test("a 5xx answer is retired as well, and is what the caller sees", async () => {
    const { node, requests } = harness({ delegate: () => new Response("boom", { status: 503 }) });
    const failure = await failureOf(node);
    await node.nodeSignOutStatus();
    expect(failure.message).toContain("Failed to activate session");
    const [delegate] = requests("POST", "/delegate");
    const retire = requests("POST", "/session/retire");
    expect(requests("POST", "/delegate")).toHaveLength(1);
    expect(retire).toHaveLength(1);
    expect(JSON.parse(retire[0]!.body ?? "{}")).toEqual({ delegations: [delegate!.authorization] });
  });
});

describe("a /delegate that never answers", () => {
  /** A node that holds the request open until the client gives up, then finishes it late, as a slow node would. */
  function slowNode() {
    const late: { authorization: string | undefined }[] = [];
    const { promise: landed, resolve: landLate } = Promise.withResolvers<void>();
    const delegate = (request: Request) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      const authorization = request.headers.get("authorization") ?? undefined;
      request.signal.addEventListener("abort", () => {
        reject(request.signal.reason);
        void landed.then(() => late.push({ authorization }));
      });
      return promise;
    };
    return { delegate, late, landLate };
  }

  test("is abandoned at the node timeout and the session is retired; the timeout is what the caller sees", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = () => realTimeout(20);
    const { delegate: hang } = slowNode();
    const { node, storage, requests } = harness({ delegate: hang });
    const failure = await failureOf(node);
    await node.nodeSignOutStatus();
    expect(failure.name).toBe("NodeNotRespondingError");
    const [delegate] = requests("POST", "/delegate");
    const retire = requests("POST", "/session/retire");
    expect(requests("POST", "/delegate")).toHaveLength(1);
    expect(requests("POST", "/invoke")).toHaveLength(0);
    expect(retire).toHaveLength(1);
    expect(JSON.parse(retire[0]!.body ?? "{}")).toEqual({ delegations: [delegate!.authorization] });
    expect(storage.exists(address)).toBe(false);
    expect(node.session).toBeUndefined();
  });

  test("the 5 s node timeout is the signal on the /delegate request itself, not only on /info", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const milliseconds = new Map<AbortSignal, number>();
    AbortSignal.timeout = (ms: number) => {
      const signal = realTimeout(ms);
      milliseconds.set(signal, ms);
      return signal;
    };
    const { node, seen } = harness({ invoke: () => new Response("Space not found", { status: 404 }) });
    await failureOf(node);
    const delegate = seen.find((entry) => entry.method === "POST" && entry.url === `${DEFAULT_NODE}/delegate`);
    expect(delegate?.signal).toBeDefined();
    expect(milliseconds.get(delegate!.signal!)).toBe(5_000);
  });

  test("a /delegate that lands after the abort is covered: the retire carries the session that was delegated", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = () => realTimeout(20);
    const { delegate, late, landLate } = slowNode();
    const { node, requests } = harness({ delegate });
    await failureOf(node);
    await node.nodeSignOutStatus();
    landLate();
    await Promise.resolve();
    const retire = requests("POST", "/session/retire");
    expect(retire).toHaveLength(1);
    // The retire does not depend on what the /delegate did: it carries the root of the very session the late /delegate carries.
    expect(late).toHaveLength(1);
    expect(JSON.parse(retire[0]!.body ?? "{}")).toEqual({ delegations: [late[0]!.authorization] });
    expect(retire[0]!.authorization).toBeDefined();
  });
});

describe("a failure before any /delegate could have been sent", () => {
  test("a wallet that cancels leaves nothing to retire", async () => {
    const { node, seen, storage } = harness({ cancelSignature: true });
    const failure = await failureOf(node);
    await node.nodeSignOutStatus();
    expect(failure.message).toContain("User rejected");
    expect(seen.filter((entry) => entry.url.endsWith("/delegate") || entry.url.endsWith("/session/retire"))).toEqual([]);
    expect(storage.exists(address)).toBe(false);
  });

  test("a /delegate the node refuses (4xx) is not retired", async () => {
    const { node, storage, requests } = harness({ delegate: () => new Response("denied", { status: 403 }) });
    const failure = await failureOf(node);
    await node.nodeSignOutStatus();
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(requests("POST", "/delegate")).toHaveLength(1);
    expect(requests("POST", "/session/retire")).toHaveLength(0);
    expect(storage.exists(address)).toBe(false);
  });
});

describe("a restored session whose hosted-space read is refused", () => {
  async function restorable() {
    const first = harness();
    await first.node.signIn();
    const session = first.node.restorableSession;
    expect(first.storage.exists(address)).toBe(true);
    return { session, storage: first.storage };
  }

  test("is removed from storage", async () => {
    const { session, storage } = await restorable();
    const restored = harness({ invoke: () => new Response("Space not found", { status: 404 }) }, storage);
    await restored.node.restoreSession({ ...session!, tinycloudHosts: [HOSTILE] });
    expect((await restored.node.kv.list({ prefix: "tc4082-notes/notes/" })).ok).toBe(false);
    expect(restored.requests("POST", "/invoke")).toHaveLength(1);
    expect(storage.exists(address)).toBe(false);
  });

  test("never removes a newer successful sign-in's session", async () => {
    const { session, storage } = await restorable();
    const { promise: answering, resolve: reached } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    let reads = 0;
    // The first read, the restore's, is held and then refused; the newer sign-in's own read answers at once.
    const restored = harness({}, storage);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname !== "/invoke") return inner(input, init);
      reads += 1;
      if (reads > 1) return inner(input, init);
      reached();
      await released;
      return new Response("Space not found", { status: 404 });
    }) as typeof fetch;
    await restored.node.restoreSession({ ...session!, tinycloudHosts: [HOSTILE] });
    const restoreRead = restored.node.kv.list({ prefix: "tc4082-notes/notes/" });
    await answering;
    await restored.node.signIn();
    const newer = restored.node.session?.delegationCid;
    expect(newer).toBeDefined();
    release();
    await restoreRead;
    expect(restored.node.session?.delegationCid).toBe(newer);
    expect(storage.exists(address)).toBe(true);
    expect((await restored.node.kv.list({ prefix: "tc4082-notes/notes/" })).ok).toBe(true);
  });
});

describe("a restored session's read when a newer sign-in is already signing in", () => {
  test("is not taken as proof for the newer session, which still has to prove itself", async () => {
    const first = harness();
    await first.node.signIn();
    const session = first.node.restorableSession;
    const { promise: readHeld, resolve: readReached } = Promise.withResolvers<void>();
    const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<void>();
    const { promise: delegateHeld, resolve: delegateReached } = Promise.withResolvers<void>();
    const { promise: delegateGate, resolve: releaseDelegate } = Promise.withResolvers<void>();
    const restored = harness({
      delegate: async () => {
        delegateReached();
        await delegateGate;
        return Response.json({ activated: [applications], skipped: [] });
      },
    }, first.storage);
    const inner = globalThis.fetch;
    let reads = 0;
    // The restore's read is held and then answers positively; every later read answers at once.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname !== "/invoke") return inner(input, init);
      reads += 1;
      if (reads > 1) return inner(input, init);
      readReached();
      await readGate;
      return Response.json([]);
    }) as typeof fetch;
    await restored.node.restoreSession({ ...session!, tinycloudHosts: [HOSTILE] });
    const restoreRead = restored.node.kv.list({ prefix: "tc4082-notes/notes/" });
    await readHeld;
    const newer = restored.node.signIn();
    await delegateHeld;
    releaseRead();
    // The read was made for the replaced session, so it proves nothing for the newer one: the old caller's list is
    // refused and never sent (only that read reached the node), and the newer session is left to prove itself.
    expect((await restoreRead).ok).toBe(false);
    expect(reads).toBe(1);
    releaseDelegate();
    await newer;
    expect(restored.node.session).toBeDefined();
    expect((await restored.node.kv.list({ prefix: "tc4082-notes/notes/" })).ok).toBe(true);
  });
});

describe("overlapping sign-ins", () => {
  test("a refusal answered to the older one never cancels the cleanup owed to the newer one", async () => {
    const olderAnswer = Promise.withResolvers<Response>();
    const newerRead = Promise.withResolvers<Response>();
    const { promise: olderSent, resolve: olderReached } = Promise.withResolvers<void>();
    const { promise: newerReadSent, resolve: newerReadReached } = Promise.withResolvers<void>();
    let sent = 0;
    const { node, requests } = harness({
      // The older /delegate is held. The newer one is accepted at once, and its strict read is held.
      delegate: () => {
        sent += 1;
        if (sent === 1) { olderReached(); return olderAnswer.promise; }
        return Response.json({ activated: [applications], skipped: [] });
      },
      invoke: () => { newerReadReached(); return newerRead.promise; },
    });
    const olderSignIn = node.signIn().then(() => undefined, (error: unknown) => error);
    await olderSent;
    const newerSignIn = node.signIn().then(() => undefined, (error: unknown) => error);
    await newerReadSent;
    // The newer sign-in's /delegate has landed and its read is pending. Now the older one's /delegate is refused (4xx) and
    // that sign-in has fully failed, before the newer read answers. A refusal that is recorded on the auth rather than on
    // the proof that sent the request would clear the newer sign-in's cleanup here.
    olderAnswer.resolve(new Response("denied", { status: 403 }));
    expect(codeOf(await olderSignIn)).toBe("ACCOUNT_SETUP_REQUIRED");
    newerRead.resolve(new Response("Space not found", { status: 404 }));
    expect(codeOf(await newerSignIn)).toBe("ACCOUNT_SETUP_REQUIRED");
    await node.nodeSignOutStatus();
    const delegates = requests("POST", "/delegate");
    const retire = requests("POST", "/session/retire");
    expect(delegates).toHaveLength(2);
    expect(retire).toHaveLength(1);
    expect(JSON.parse(retire[0]!.body ?? "{}")).toEqual({ delegations: [delegates[1]!.authorization] });
    expect(node.session).toBeUndefined();
  });
});

describe("a sign-in replaced after its /delegate landed (prepareOpenKeySignIn runs while it is in flight)", () => {
  /** The wallet sign-in fails as replaced; its session stays current and stored, and is not retired. */
  async function replaced(invoke: () => Response) {
    const { promise: held, resolve: reached } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const built = harness({
      delegate: async () => {
        reached();
        await gate;
        return Response.json({ activated: [applications], skipped: [] });
      },
      invoke,
    });
    const signIn = built.node.signIn().then(() => undefined, (error: unknown) => error);
    await held;
    await built.node.prepareOpenKeySignIn();
    release();
    const failure = await signIn;
    await built.node.nodeSignOutStatus();
    return { ...built, failure };
  }

  test("known behaviour: the session stays stored and is not retired, but nothing in this process can use it", async () => {
    const { node, storage, requests, failure } = await replaced(() => Response.json([]));
    expect((failure as Error).message).toContain("replaced before the hosted-space check finished");
    expect(node.session).toBeDefined();
    expect(storage.exists(address)).toBe(true);
    expect(requests("POST", "/session/retire")).toHaveLength(0);
    // No service was set up for it and no read was sent: it routes nowhere.
    expect(() => node.kv.list({ prefix: "tc4082-notes/notes/" })).toThrow("Not signed in");
    expect(requests("POST", "/invoke")).toHaveLength(0);
  });

  test("restoring it needs a read the node refuses: the restored session is refused and its record removed", async () => {
    const { node, storage } = await replaced(() => Response.json([]));
    const stranded = node.restorableSession;
    const restored = harness({ invoke: () => new Response("Space not found", { status: 404 }) }, storage);
    await restored.node.restoreSession({ ...stranded!, tinycloudHosts: [HOSTILE] });
    expect((await restored.node.kv.list({ prefix: "tc4082-notes/notes/" })).ok).toBe(false);
    // Exactly the one strict read; the list itself was never sent.
    expect(restored.requests("POST", "/invoke")).toHaveLength(1);
    expect(storage.exists(address)).toBe(false);
  });

  test("restoring it is only proven by a 2xx read of the owner's own space, as for any restored session", async () => {
    const { node, storage } = await replaced(() => Response.json([]));
    const stranded = node.restorableSession;
    const restored = harness({ invoke: () => Response.json([]) }, storage);
    await restored.node.restoreSession({ ...stranded!, tinycloudHosts: [HOSTILE] });
    expect((await restored.node.kv.list({ prefix: "tc4082-notes/notes/" })).ok).toBe(true);
    // The strict read came first, then the list.
    expect(restored.requests("POST", "/invoke")).toHaveLength(2);
  });
});
