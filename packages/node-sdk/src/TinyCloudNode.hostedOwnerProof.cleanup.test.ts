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
}

interface Behaviour {
  /** The answer to `/delegate`; may reject (a transport error) or follow the request's signal (a hang). */
  delegate?: (request: Request) => Response | Promise<Response>;
  invoke?: () => Response;
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
      method: request.method, url: `${url.origin}${url.pathname}`,
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
    // The retire carries the root delegation the node was given for this very session, and is signed by that session's key.
    expect(JSON.parse(retire[0]!.body ?? "{}")).toEqual({ delegations: [expect.any(String)] });
    expect(delegate[0]!.authorization).toBeDefined();
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
    expect(requests("POST", "/session/retire")).toHaveLength(1);
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
    expect(requests("POST", "/delegate")).toHaveLength(1);
    expect(requests("POST", "/invoke")).toHaveLength(0);
    expect(requests("POST", "/session/retire")).toHaveLength(1);
    expect(storage.exists(address)).toBe(false);
    expect(node.session).toBeUndefined();
  });

  test("a 5xx answer is retired as well, and is what the caller sees", async () => {
    const { node, requests } = harness({ delegate: () => new Response("boom", { status: 503 }) });
    const failure = await failureOf(node);
    await node.nodeSignOutStatus();
    expect(failure.message).toContain("Failed to activate session");
    expect(requests("POST", "/delegate")).toHaveLength(1);
    expect(requests("POST", "/session/retire")).toHaveLength(1);
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
    const timeouts: number[] = [];
    AbortSignal.timeout = (ms: number) => { timeouts.push(ms); return realTimeout(20); };
    const { delegate } = slowNode();
    const { node, storage, requests } = harness({ delegate });
    const failure = await failureOf(node);
    await node.nodeSignOutStatus();
    expect(failure.name).toBe("NodeNotRespondingError");
    expect(timeouts).toContain(5_000);
    expect(requests("POST", "/delegate")).toHaveLength(1);
    expect(requests("POST", "/invoke")).toHaveLength(0);
    expect(requests("POST", "/session/retire")).toHaveLength(1);
    expect(storage.exists(address)).toBe(false);
    expect(node.session).toBeUndefined();
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
    // The retire does not depend on what the /delegate did: it names the same session root the late /delegate carries.
    expect(late).toHaveLength(1);
    expect(late[0]!.authorization).toBeDefined();
    expect(retire[0]!.body).toContain(late[0]!.authorization!.replace(/^Bearer /, ""));
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
