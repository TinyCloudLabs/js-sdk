import "./support/browserGlobalsShim";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";

const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const open = mock(() => ({}));
let priorWindow: typeof globalThis.window | undefined;
beforeEach(() => {
  priorWindow = globalThis.window;
  globalThis.window = {
    location: { host: "example.test", hostname: "example.test", origin: "https://example.test" },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    open,
  } as unknown as Window & typeof globalThis;
});
afterEach(() => {
  if (priorWindow === undefined) delete (globalThis as any).window;
  else globalThis.window = priorWindow;
});

// Use the real TinyCloudWeb, TinyCloudNode, and authorization bridge. Only
// the wallet transport and OpenKey approval result are controlled by the test.
function client(approval?: (request: { siwe: string }) => Promise<unknown>) {
  const modes: unknown[] = [];
  const legacyCalls: string[] = [];
  const openkey = {
    authorizeTinyCloud(request: { siwe: string }, opts: unknown) {
      modes.push(opts);
      window.open("https://openkey.example.test/widget/sign", "openkey");
      return approval?.(request) ?? Promise.reject(new Error("approval stopped by test"));
    },
    signMessage() {
      legacyCalls.push("signMessage");
      throw new Error("Legacy signing called");
    },
  };
  const provider = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return "0x1";
      legacyCalls.push(method);
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  };
  return {
    modes,
    legacyCalls,
    provider,
    create: () => require("../dist/index.cjs").TinyCloudWeb.create({
      provider,
      openkey: { client: openkey },
      tinycloudHosts: ["https://node.example.test"],
      autoDiscoverLocalNode: false,
      persistSession: false,
      autoCreateSpace: false,
      autoBootstrapAccount: false,
      ui: false,
    }),
  };
}

async function signedResult(request: { siwe: string }) {
  const selectedActionKeys: string[] = [];
  const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
  for (const [resource, actions] of Object.entries(extractRecapAttenuations(request.siwe))) {
    const { space, path } = parseCanonicalRecapResource(resource);
    const grouped = new Map<string, string[]>();
    for (const ability of Object.keys(actions)) {
      const service = ability.split("/")[0]!;
      if (ability !== "tinycloud.capabilities/read" && ability !== "capabilities/read") {
        selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
      }
      grouped.set(service, [...(grouped.get(service) ?? []), ability]);
    }
    for (const [service, abilities] of grouped) {
      permissions.push({ service, space, path, actions: abilities });
    }
  }
  return {
    protocolVersion: 1 as const,
    address,
    signature: await signer.signMessage({ message: request.siwe }),
    signedMessage: request.siwe,
    selectedActionKeys,
    permissions,
  };
}

async function withNodeFetch<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("prepared OpenKey sign-in opens the popup in the click handler", async () => {
  open.mockClear();
  const setup = client();
  const web = await setup.create();
  await web.prepareSignIn();
  let beforeFirstMicrotask = false;
  const click = () => {
    const signing = web.signIn();
    beforeFirstMicrotask = open.mock.calls.length === 1;
    return signing;
  };
  await expect(click()).rejects.toThrow("approval stopped by test");
  expect(beforeFirstMicrotask).toBe(true);
  expect(setup.modes).toEqual([{ mode: "popup" }]);
  expect(setup.legacyCalls).toEqual([]);
});

test("OpenKey sign-in without preparation opens after the click handler", async () => {
  open.mockClear();
  const setup = client();
  const web = await setup.create();
  const signing = web.signIn();
  expect(open.mock.calls).toHaveLength(0);
  await expect(signing).rejects.toThrow("approval stopped by test");
  expect(open.mock.calls).toHaveLength(1);
  expect(setup.modes).toEqual([{ mode: "popup" }]);
  expect(setup.legacyCalls).toEqual([]);
});

test("an expired prepared request needs preparation before another click", async () => {
  open.mockClear();
  const setup = client();
  const web = await setup.create();
  await web.prepareSignIn();
  (web as any).preparedSignIn.createdAt = Date.now() - 5 * 60_000 - 1;
  await expect(web.signIn()).rejects.toThrow("call prepareSignIn() again");
  expect(open.mock.calls).toHaveLength(0);
  await web.prepareSignIn();
  const signing = web.signIn();
  expect(open.mock.calls).toHaveLength(1);
  await expect(signing).rejects.toThrow("approval stopped by test");
});

test("prepared OpenKey approval completes a session and reaches activation", async () => {
  await withNodeFetch(async () => {
    open.mockClear();
    const setup = client(signedResult);
    const web = await setup.create();
    await web.prepareSignIn();
    const session = await web.signIn();
    expect(session.address).toBe(address);
    expect(web.session()?.address).toBe(address);
    expect(open.mock.calls).toHaveLength(1);
    expect(setup.legacyCalls).toEqual([]);
    expect((web as any).preparedSignIn).toBeUndefined();
  });
});

test("a second preparation is refused while prepared approval is open", async () => {
  await withNodeFetch(async () => {
    let approve!: (value: unknown) => void;
    let request!: { siwe: string };
    const setup = client((input) => {
      request = input;
      return new Promise((resolve) => { approve = resolve; });
    });
    const web = await setup.create();
    await web.prepareSignIn();
    const signing = web.signIn();
    await expect(web.prepareSignIn()).rejects.toThrow("in progress");
    approve(await signedResult(request));
    await expect(signing).resolves.toMatchObject({ address });
  });
});

test("the prepared slot is consumed after a canceled approval", async () => {
  const web = await client().create();
  await web.prepareSignIn();
  await expect(web.signIn()).rejects.toThrow("approval stopped by test");
  expect((web as any).preparedSignIn).toBeUndefined();
});

test("a wallet SIWE override leaves the prepared request available", async () => {
  const web = await client().create();
  await web.prepareSignIn();
  const pending = (web as any).preparedSignIn;
  await expect(web.signIn({ nonce: "n" })).rejects.toThrow("wallet SIWE overrides");
  expect((web as any).preparedSignIn).toBe(pending);
});

test("the latest concurrent preparation owns the prepared slot", async () => {
  const web = await client().create();
  const node = (web as any)._node;
  const original = node.prepareOpenKeySignIn.bind(node);
  let release!: () => void;
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  node.prepareOpenKeySignIn = async () => {
    const pending = await original();
    if (++calls === 1) {
      entered();
      await gate;
    }
    return pending;
  };
  const first = web.prepareSignIn();
  await firstEntered;
  await web.prepareSignIn();
  const latest = (web as any).preparedSignIn;
  release();
  await expect(first).rejects.toThrow("superseded");
  expect((web as any).preparedSignIn).toBe(latest);
});

test("account change after preparation refuses completion", async () => {
  const web = await client().create();
  await web.prepareSignIn();
  const node = (web as any)._node;
  node.signer.getAddress = async () => "0x0000000000000000000000000000000000000001";
  await expect(web.signIn()).rejects.toThrow("account changed after sign-in preparation");
  expect((web as any).preparedSignIn).toBeUndefined();
});

test("sign-out clears a prepared request", async () => {
  const web = await client().create();
  await web.prepareSignIn();
  await web.signOut();
  expect((web as any).preparedSignIn).toBeUndefined();
});

test("connectWallet clears a prepared request", async () => {
  const setup = client();
  const web = await setup.create();
  await web.prepareSignIn();
  expect(() => web.connectWallet(setup.provider)).toThrow("Signer already connected");
  expect((web as any).preparedSignIn).toBeUndefined();
});

test("setManifest clears a prepared request", async () => {
  const web = await client().create();
  await web.prepareSignIn();
  web.setManifest({ name: "Example", app_id: "example", permissions: [] } as any);
  expect((web as any).preparedSignIn).toBeUndefined();
});

test("setCapabilityRequest clears a prepared request", async () => {
  const web = await client().create();
  await web.prepareSignIn();
  web.setCapabilityRequest({ manifests: [], resources: [] } as any);
  expect((web as any).preparedSignIn).toBeUndefined();
});

test("sign-out invalidates the prepared authorization generation", async () => {
  const web = await client().create();
  await web.prepareSignIn();
  const pending = (web as any).preparedSignIn.request;
  const auth = (web as any)._node.auth;
  await web.signOut();
  await expect(auth.completeOpenKeySignIn(pending, Promise.resolve({}))).rejects.toThrow("after sign-out");
});

test("node rejects reuse and age of a prepared authorization", async () => {
  const web = await client().create();
  await web.prepareSignIn();
  const pending = (web as any).preparedSignIn.request;
  const node = (web as any)._node;
  await expect(web.signIn()).rejects.toThrow("approval stopped by test");
  expect(() => node.signInWithPreparedOpenKey(pending, () => Promise.reject())).toThrow("already used");
  await web.prepareSignIn();
  const stale = (web as any).preparedSignIn.request;
  stale.createdAt = Date.now() - 5 * 60_000 - 1;
  expect(() => node.signInWithPreparedOpenKey(stale, () => Promise.reject())).toThrow("expired");
  await expect(node.auth.completeOpenKeySignIn(stale, Promise.resolve({}))).rejects.toThrow("expired");
});

test("preparation keeps the active session key available until approval", async () => {
  await withNodeFetch(async () => {
    const web = await client(signedResult).create();
    await web.prepareSignIn();
    await web.signIn();
    const node = (web as any)._node;
    const activeKey = node.session.sessionKey;
    const activeDid = node.auth.sessionManager.getDID(activeKey);
    await web.prepareSignIn();
    expect(node.session.sessionKey).toBe(activeKey);
    expect(node.auth.sessionManager.getDID(activeKey)).toBe(activeDid);
    expect((web as any).preparedSignIn.request.keyId).not.toBe(activeKey);
  });
});
