import { beforeEach, expect, mock, test } from "bun:test";

const { TextEncoder: TE, TextDecoder: TD } = require("util");

global.TextEncoder = TE;
global.TextDecoder = TD;
(globalThis as any).HTMLElement = class {
  shadowRoot: any;
  attachShadow() {
    this.shadowRoot = { innerHTML: "", querySelector: () => null };
    return this.shadowRoot;
  }
  remove() {}
};
(globalThis as any).customElements = {
  define: () => undefined,
  get: () => undefined,
};
(globalThis as any).window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  location: { hostname: "test.local" },
};
(globalThis as any).document = {
  createElement: () => ({
    setAttribute: () => undefined,
    appendChild: () => undefined,
    remove: () => undefined,
    style: {},
  }),
  body: {
    appendChild: () => undefined,
    style: {},
  },
};

// Load web-sdk from its built dist, as the other web-sdk JS tests do. Source
// imports would be replaced by openkey-session.test.ts's process-wide
// mock.module("../src/modules/tcw"), since bun runs all files in one process.
const web = require("../dist/index.cjs");
const { TinyCloudWeb } = web;

const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
const replicationStorage = { get: async () => undefined, put: async () => undefined };

test("forwards the replication config to the node config unchanged", async () => {
  const replication = {
    enabled: false,
    prefixes: ["app/"],
    storage: replicationStorage,
  };
  const tcw = new TinyCloudWeb({ replication });

  await (tcw as any)._initPromise;

  expect((tcw as any)._node.config.replication).toBe(replication);
});

test("leaves the node replication config absent when replication is not configured", async () => {
  const tcw = new TinyCloudWeb({});

  await (tcw as any)._initPromise;

  expect(Object.hasOwn((tcw as any)._node.config, "replication")).toBe(false);
  expect(tcw.replication).toBeUndefined();
});

test("exposes the node replication control through the web-sdk instance", async () => {
  const status = [{ prefix: "app/", state: "idle" }];
  const runtime = mock(async () => ({
    ReplicationRuntime: class {
      control = {
        status: async () => status,
        sync: async () => undefined,
        purge: async () => undefined,
        clearPending: async () => undefined,
        close: async () => undefined,
      };
    },
  }));
  web.registerReplicationLoaders({
    runtime,
    authority: async () => ({ replicationScopeFromSignedSession: () => null }),
  });

  const tcw = new TinyCloudWeb({
    replication: { enabled: true, prefixes: ["app/"], storage: replicationStorage },
  });
  await (tcw as any)._initPromise;

  expect(runtime).toHaveBeenCalledTimes(1);
  expect(await tcw.replication?.status()).toEqual(status);
});

test("delivers replication events to the onEvent callback passed to TinyCloudWeb", async () => {
  const delivered: unknown[] = [];
  let runtimeOptions: any;
  const runtime = mock(async () => ({
    ReplicationRuntime: class {
      control = {
        status: async () => [],
        sync: async () => undefined,
        purge: async () => undefined,
        clearPending: async () => undefined,
        close: async () => undefined,
      };
      constructor(options: any) {
        runtimeOptions = options;
      }
    },
  }));
  web.registerReplicationLoaders({
    runtime,
    authority: async () => ({ replicationScopeFromSignedSession: () => null }),
  });

  const tcw = new TinyCloudWeb({
    replication: {
      enabled: true,
      prefixes: ["notes/"],
      storage: replicationStorage,
      onEvent: (event: unknown) => delivered.push(event),
    },
  });
  await (tcw as any)._initPromise;
  await tcw.replication?.status();

  const event = { type: "replication.read", key: "notes/a", source: "replica" };
  runtimeOptions.onEvent(event);

  expect(delivered).toEqual([event]);
});

beforeEach(() => {
  web.registerReplicationLoaders({
    runtime: async () => ({
      ReplicationRuntime: class {
        control = {
          status: async () => [],
          sync: async () => undefined,
          purge: async () => undefined,
          clearPending: async () => undefined,
          close: async () => undefined,
        };
      },
    }),
    authority: async () => ({ replicationScopeFromSignedSession: () => null }),
  });
});

function persistedRecord(extra: Record<string, unknown> = {}) {
  return {
    address,
    chainId: 1,
    sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "private" }),
    siwe: "siwe",
    signature: "signature",
    tinycloudSession: {
      delegationHeader: { Authorization: "Bearer persisted" },
      delegationCid: "bafy-persisted",
      spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
      verificationMethod: "did:key:zPersisted#zPersisted",
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    version: "1.0",
    ...extra,
  };
}

function stubRestore(tcw: any, data: Record<string, unknown>) {
  const node = {
    hasRuntimePermissions: mock(() => true),
    signIn: mock(async () => undefined),
    restoreSession: mock(async () => undefined),
    accountSpaceId: `tinycloud:pkh:eip155:1:${address}:account`,
    spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
    session: { address, chainId: 1, sessionKey: "k", siwe: "s", signature: "g" },
  };
  tcw._node = node;
  tcw._initPromise = Promise.resolve();
  tcw.ensureNode = mock(async () => node);
  tcw.resolveRestoreAddress = mock(async () => address);
  tcw.loadPersistedSession = mock(async () => ({ status: "loaded", data }));
  tcw.clearPersistedSession = mock(async () => undefined);
  return { node, clearPersistedSession: tcw.clearPersistedSession };
}

test("signIn takes the fresh sign-in path when a replication-enabled restore has no replica stamp", async () => {
  const tcw = new TinyCloudWeb({
    replication: { enabled: true, prefixes: ["app/"], storage: replicationStorage },
  });
  const { node, clearPersistedSession } = stubRestore(tcw, persistedRecord());

  await tcw.signIn();

  expect(node.signIn).toHaveBeenCalledTimes(1);
  expect(clearPersistedSession).toHaveBeenCalledTimes(1);
});

test("signIn keeps a covered restored session that carries a replica stamp", async () => {
  const tcw = new TinyCloudWeb({
    replication: { enabled: true, prefixes: ["app/"], storage: replicationStorage },
  });
  const { node } = stubRestore(
    tcw,
    persistedRecord({ replicaStamp: { incarnation: "inc-1", lifecycleEpoch: 1 }, siwe: siweIssuedAt(ONE_DAY_AGO) }),
  );

  const session = await tcw.signIn();

  expect(node.signIn).not.toHaveBeenCalled();
  expect(session.address).toBe(address);
});

test("signIn does not require a replica stamp when replication is off", async () => {
  const tcw = new TinyCloudWeb({});
  const { node } = stubRestore(tcw, persistedRecord());

  const session = await tcw.signIn();

  expect(node.signIn).not.toHaveBeenCalled();
  expect(session.address).toBe(address);
});

function siweIssuedAt(issuedAt: string): string {
  return ["localhost wants you to sign in with your Ethereum account:", address, "", `Issued At: ${issuedAt}`].join("\n");
}

const ONE_DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
const primarySpace = `tinycloud:pkh:eip155:1:${address}:default`;

test("signIn re-consents when the restored session lacks get and sync on the replication prefixes", async () => {
  const tcw = new TinyCloudWeb({
    replication: { enabled: true, prefixes: ["app/"], storage: replicationStorage },
  });
  const { node, clearPersistedSession } = stubRestore(
    tcw,
    persistedRecord({ replicaStamp: { incarnation: "inc-1", lifecycleEpoch: 1 }, siwe: siweIssuedAt(ONE_DAY_AGO) }),
  );
  node.hasRuntimePermissions = mock((entries: Array<{ service: string; path?: string }>) => !entries.some((entry) => entry.service === "tinycloud.kv" && entry.path === "app/"));

  await tcw.signIn();

  expect(node.hasRuntimePermissions).toHaveBeenCalledWith([
    expect.objectContaining({ service: "tinycloud.kv", space: primarySpace, path: "app/" }),
  ]);
  expect(node.signIn).toHaveBeenCalledTimes(1);
  expect(clearPersistedSession).toHaveBeenCalledTimes(1);
});

test("signIn re-consents once the 7-day consent deadline has passed", async () => {
  const tcw = new TinyCloudWeb({
    replication: { enabled: true, prefixes: ["app/"], storage: replicationStorage },
  });
  const { node } = stubRestore(
    tcw,
    persistedRecord({ replicaStamp: { incarnation: "inc-1", lifecycleEpoch: 1 }, siwe: siweIssuedAt(EIGHT_DAYS_AGO) }),
  );

  await tcw.signIn();

  expect(node.signIn).toHaveBeenCalledTimes(1);
});

test("signIn accepts a restored session past the consent deadline while offline", async () => {
  const tcw = new TinyCloudWeb({
    replication: { enabled: true, prefixes: ["app/"], storage: replicationStorage },
  });
  const { node } = stubRestore(
    tcw,
    persistedRecord({ replicaStamp: { incarnation: "inc-1", lifecycleEpoch: 1 }, siwe: siweIssuedAt(EIGHT_DAYS_AGO) }),
  );
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
  try {
    const session = await tcw.signIn();
    expect(node.signIn).not.toHaveBeenCalled();
    expect(session.address).toBe(address);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as any).navigator;
  }
});

test("signIn ignores the consent deadline when replication is off", async () => {
  const tcw = new TinyCloudWeb({});
  const { node } = stubRestore(tcw, persistedRecord({ siwe: siweIssuedAt(EIGHT_DAYS_AGO) }));

  await tcw.signIn();

  expect(node.signIn).not.toHaveBeenCalled();
});

test("after re-consent with secrets opt-in off, the next restore counts as covered and does not prompt", async () => {
  // Config validation rejects vault prefixes without allowSecrets, so this case
  // uses only an app/ prefix. The secrets filter is pinned in replicationReconsent.test.ts.
  // The covered-check must match the grant node issues, or every load re-consents.
  const granted = new Set<string>();
  const replication = { enabled: true, prefixes: ["app/"], storage: replicationStorage };
  const stamped = persistedRecord({
    replicaStamp: { incarnation: "inc-1", lifecycleEpoch: 1 },
    siwe: siweIssuedAt(ONE_DAY_AGO),
  });
  const load = () => {
    const tcw = new TinyCloudWeb({ replication });
    const { node } = stubRestore(tcw, stamped);
    // Manifest entries stay covered so the replication check is reached; only app/ is gated.
    node.hasRuntimePermissions = mock((entries: Array<{ service: string; path?: string }>) =>
      entries.every((entry) => entry.path?.startsWith("app/") !== true || granted.has(`${entry.service}|${entry.path}`)),
    );
    node.signIn = mock(async () => {
      granted.add("tinycloud.kv|app/");
    });
    return { tcw, node };
  };

  const first = load();
  await first.tcw.signIn();
  expect(first.node.signIn).toHaveBeenCalledTimes(1);
  const requested = (first.node.hasRuntimePermissions as unknown as { mock: { calls: unknown[][][] } }).mock.calls.flat(2);
  expect(requested).toContainEqual(
    expect.objectContaining({ service: "tinycloud.kv", space: primarySpace, path: "app/" }),
  );

  const second = load();
  await second.tcw.signIn();
  expect(second.node.signIn).not.toHaveBeenCalled();
});
