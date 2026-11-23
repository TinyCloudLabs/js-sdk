import { afterEach, describe, expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { signedLocationRecordForTest, signedRegistryResponseForTest } from "./test-support/restored-policy-node";

/**
 * TC-4082: an owner with no registry record signs in for a third-party app when the pinned default node already
 * hosts their own `applications` space: one `/delegate` after consent and one strict read, nothing else.
 */
const DEFAULT_NODE = "https://node.tinycloud.xyz";
const REGISTRY = "https://registry.hosted-owner.test";
const HOSTILE = "https://configured.hosted-owner.test";
const key = "21".repeat(32);
const signer = new PrivateKeySigner(key);
const address = await signer.getAddress();
const applications = `tinycloud:pkh:eip155:1:${address}:applications`;
const sameOwnerOtherSpace = `tinycloud:pkh:eip155:1:${address}:default`;

const withList = [{ service: "tinycloud.kv", path: "notes/", actions: ["get", "list"] }];
const withoutList = [{ service: "tinycloud.kv", path: "notes/", actions: ["get", "put"] }];
const withInfo = [{ service: "tinycloud.space", path: "", actions: ["info"] }];

interface Scenario {
  permissions?: object[];
  registry?: "missing" | "registered" | "unavailable";
  delegate?: () => Response;
  invoke?: () => Response;
  node?: Partial<ConstructorParameters<typeof TinyCloudNode>[0]>;
}

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

function codeOf(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function run(scenario: Scenario = {}) {
  const requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  const signed: string[] = [];
  const storage = new MemorySessionStorage();
  const nodeDid = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const record = scenario.registry === "registered"
    ? await signedLocationRecordForTest({ ownerDid: `did:pkh:eip155:1:${address}`, ownerPrivateKey: key, host: DEFAULT_NODE, nodeDid, spaces: [applications], sequence: 1 })
    : undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url: `${url.origin}${url.pathname}`, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url.origin === REGISTRY) {
      if (scenario.registry === "unavailable") return new Response("unavailable", { status: 503 });
      const response = record ? signedRegistryResponseForTest(input, init, REGISTRY, record) : undefined;
      return response ?? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
    }
    if (url.origin === DEFAULT_NODE) {
      if (url.pathname === "/info") return Response.json({ nodeId: nodeDid, protocol: 1, version: "1.26.22", features: [] });
      if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid });
      if (url.pathname === "/delegate") return scenario.delegate?.() ?? Response.json({ activated: [applications], skipped: [] });
      if (url.pathname === "/invoke") return scenario.invoke?.() ?? Response.json([]);
    }
    throw new Error(`Unexpected request ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  const node = new TinyCloudNode({
    host: HOSTILE,
    newUserHost: HOSTILE,
    tinycloudFallbackHosts: [HOSTILE],
    tinycloudRegistryUrl: REGISTRY,
    autoDiscoverLocalNode: false,
    wasmBindings: new NodeWasmBindings(),
    signer: {
      getAddress: () => signer.getAddress(),
      getChainId: () => signer.getChainId(),
      signMessage: (message: string) => { signed.push(message); return signer.signMessage(message); },
    },
    sessionStorage: storage,
    requireExistingAccount: true,
    allowHostedOwnerProof: true,
    autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false,
    enablePublicSpace: false,
    manifest: { app_id: "tc4082-notes", name: "Notes", defaults: false, includePublicSpace: false, permissions: scenario.permissions ?? withList },
    ...scenario.node,
  } as ConstructorParameters<typeof TinyCloudNode>[0]);
  let failure: unknown;
  try {
    await node.signIn();
  } catch (error) {
    failure = error;
  }
  const paths = (path: string) => requests.filter((request) => request.url === `${DEFAULT_NODE}${path}`);
  return { node, requests, signed, storage, failure, paths };
}

describe("a hosted owner with no registry record", () => {
  test("signs in with one /delegate and one kv/list of limit 1, all at the pinned default node", async () => {
    const { node, requests, signed, failure, paths } = await run();
    expect(failure).toBeUndefined();
    expect(signed).toHaveLength(1);
    expect(paths("/delegate")).toHaveLength(1);
    const reads = paths("/invoke");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.headers["x-tinycloud-limit"]).toBe("1");
    expect(requests.filter((request) => request.url.startsWith(HOSTILE))).toEqual([]);
    expect(requests.map((request) => request.url)).not.toContain(`${DEFAULT_NODE}/session/retire`);
    expect(node.session?.spaceId).toBe(applications);
    // Nothing but the one delegation was written: no account, space, key or network setup.
    expect(requests.filter((request) => request.method !== "GET" && request.url !== `${DEFAULT_NODE}/delegate` && request.url !== `${DEFAULT_NODE}/invoke`)).toEqual([]);
  });

  test("space/info proves it as well when it is the read the request holds", async () => {
    const { failure, paths, requests } = await run({ permissions: withInfo });
    expect(failure).toBeUndefined();
    expect(paths("/delegate")).toHaveLength(1);
    expect(paths("/invoke")).toHaveLength(1);
    expect(requests.filter((request) => request.url.startsWith(HOSTILE))).toEqual([]);
  });

  test("a delegation that does not activate the exact primary space is refused, with no read and no retry", async () => {
    for (const body of [{ activated: [], skipped: [applications] }, { activated: [sameOwnerOtherSpace], skipped: [] }, { activated: [], skipped: [] }]) {
      const { failure, paths, signed, storage } = await run({ delegate: () => Response.json(body) });
      expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
      expect(signed).toHaveLength(1);
      expect(paths("/delegate")).toHaveLength(1);
      expect(paths("/invoke")).toHaveLength(0);
      expect(storage.exists(address)).toBe(false);
    }
  });

  test.each([400, 401, 403, 404, 410])("a %d on the read is not positive: setup required, session cleared, no second /delegate", async (status) => {
    const { failure, paths, storage, requests, node } = await run({ invoke: () => new Response("Space not found", { status }) });
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(paths("/delegate")).toHaveLength(1);
    expect(paths("/invoke")).toHaveLength(1);
    expect(storage.exists(address)).toBe(false);
    expect(node.session).toBeUndefined();
    expect(requests.filter((request) => request.method !== "GET").map((request) => request.url).sort())
      .toEqual([`${DEFAULT_NODE}/delegate`, `${DEFAULT_NODE}/invoke`]);
  });

  test("a 5xx or a network error on the read is not setup: it fails without the setup code and clears the session", async () => {
    for (const invoke of [() => new Response("boom", { status: 503 }), () => { throw new TypeError("network down"); }]) {
      const { failure, paths, storage } = await run({ invoke });
      expect(failure).toBeDefined();
      expect(codeOf(failure)).not.toBe("ACCOUNT_SETUP_REQUIRED");
      expect(paths("/delegate")).toHaveLength(1);
      expect(paths("/invoke")).toHaveLength(1);
      expect(storage.exists(address)).toBe(false);
    }
  });

  test("a failed /delegate is not retried and writes nothing else", async () => {
    for (const status of [401, 403, 500, 503]) {
      const { failure, paths, requests } = await run({ delegate: () => new Response("no", { status }) });
      expect(failure).toBeDefined();
      expect(paths("/delegate")).toHaveLength(1);
      expect(paths("/invoke")).toHaveLength(0);
      if (status < 500) expect(requests.map((request) => request.url)).not.toContain(`${DEFAULT_NODE}/session/retire`);
    }
  });
});

describe("requests that cannot be proven are refused before anything is signed", () => {
  test.each([
    ["no held list or info", withoutList],
    ["a space host ability", [...withList, { service: "tinycloud.space", path: "", actions: ["host"] }]],
    ["a space create or delete ability", [...withList, { service: "tinycloud.space", path: "", actions: ["delete"] }]],
  ])("%s", async (_name, permissions) => {
    const { failure, signed, requests } = await run({ permissions });
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(signed).toHaveLength(0);
    expect(requests.filter((request) => request.url.startsWith(DEFAULT_NODE))).toEqual([]);
    expect(requests.filter((request) => request.url.startsWith(HOSTILE))).toEqual([]);
  });

  test("the flag is required, and an unavailable registry is never a verdict", async () => {
    const off = await run({ node: { allowHostedOwnerProof: false } });
    expect(codeOf(off.failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(off.signed).toHaveLength(0);
    expect(off.requests.filter((request) => request.url.startsWith(DEFAULT_NODE))).toEqual([]);
    const unavailable = await run({ registry: "unavailable" });
    expect(codeOf(unavailable.failure)).not.toBe("ACCOUNT_SETUP_REQUIRED");
    expect(unavailable.signed).toHaveLength(0);
    expect(unavailable.requests.filter((request) => request.url.startsWith(DEFAULT_NODE))).toEqual([]);
  });

  test("a creation handler or autoCreateSpace never creates anything for the proof", async () => {
    let asked = 0;
    const { failure, requests } = await run({
      invoke: () => new Response("Space not found", { status: 404 }),
      node: { autoCreateSpace: true, spaceCreationHandler: { confirmSpaceCreation: async () => { asked++; return true; }, onSpaceCreated() {}, onSpaceCreationFailed() {} } as never },
    });
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(asked).toBe(0);
    expect(requests.map((request) => request.url)).not.toContain(`${DEFAULT_NODE}/peer/generate/${applications}`);
    expect(requests.filter((request) => request.method !== "GET").map((request) => request.url).sort())
      .toEqual([`${DEFAULT_NODE}/delegate`, `${DEFAULT_NODE}/invoke`]);
  });
});

describe("owners the registry knows are unchanged", () => {
  test("a registered owner never takes the proof path", async () => {
    const { requests, failure } = await run({ registry: "registered" });
    // Routing comes from the record: the proof's one-/delegate-and-one-read shape is not used.
    expect(requests.filter((request) => request.url === `${DEFAULT_NODE}/invoke`)).toHaveLength(0);
    expect(codeOf(failure)).not.toBe("ACCOUNT_SETUP_REQUIRED");
  });
});

describe("a restored session of a hosted owner with no registry record", () => {
  async function restored(options: { flag?: boolean; invoke?: () => Response; first?: Awaited<ReturnType<typeof run>> }) {
    const first = options.first ?? await run();
    expect(first.failure).toBeUndefined();
    const persisted = first.node.restorableSession;
    expect(persisted).toBeDefined();
    const before = first.requests.length;
    const node = new TinyCloudNode({
      host: HOSTILE, newUserHost: HOSTILE, tinycloudFallbackHosts: [HOSTILE], tinycloudRegistryUrl: REGISTRY,
      autoDiscoverLocalNode: false, wasmBindings: new NodeWasmBindings(), signer,
      requireExistingAccount: true, allowHostedOwnerProof: options.flag ?? true, autoBootstrapAccount: false,
    });
    const base = globalThis.fetch;
    if (options.invoke) {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return url.origin === DEFAULT_NODE && url.pathname === "/invoke" ? options.invoke!() : base(input, init);
      }) as typeof fetch;
    }
    await node.restoreSession({ ...persisted!, tinycloudHosts: [HOSTILE] });
    let failure: unknown;
    try {
      const listed = await node.kv.list({ prefix: "tc4082-notes/notes/" });
      if (!listed.ok) failure = listed.error.cause ?? listed.error;
    } catch (error) {
      failure = error;
    }
    return { node, failure, later: first.requests.slice(before) };
  }

  test("is proven by one strict read and no /delegate, and the pinned host is the only one used", async () => {
    const { later, failure } = await restored({});
    expect(later.filter((request) => request.url.endsWith("/delegate"))).toEqual([]);
    expect(later.filter((request) => request.url.startsWith(HOSTILE))).toEqual([]);
    expect(later.filter((request) => request.url.endsWith("/invoke") && request.headers["x-tinycloud-limit"] === "1")).toHaveLength(1);
    expect(failure).toBeUndefined();
  });

  test("a read that is not a 2xx leaves the restored session refused", async () => {
    const { later, failure } = await restored({ invoke: () => new Response("Space not found", { status: 404 }) });
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(later.filter((request) => request.url.endsWith("/delegate"))).toEqual([]);
  });

  test("without the flag nothing is proven and nothing is read", async () => {
    const { later, failure } = await restored({ flag: false });
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(later.filter((request) => request.url.startsWith(DEFAULT_NODE))).toEqual([]);
  });
});
