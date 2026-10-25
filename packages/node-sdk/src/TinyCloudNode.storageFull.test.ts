/**
 * TC-628 — one `storage.full` event, `storage.status()`, and no doomed writes
 * on read paths, against a fake node whose account storage is full: every
 * write is refused with the node's structured 402 and every read succeeds.
 */

import { describe, expect, mock, test } from "bun:test";

import {
  ErrorCodes,
  KVService,
  ServiceContext,
  type FetchFunction,
  type IWasmBindings,
  type StorageFullEvent,
} from "@tinycloud/sdk-core";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const SPACE_URI = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
/** A space owned by a different account, e.g. one shared with this user. */
const OTHER_SPACE = "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000aa:shared";
const SPACE_INFO = "tinycloud.space/info";

const REJECTION = JSON.stringify({
  error: "storage_quota_exceeded",
  message: "Storage quota exceeded. Used: 155744 bytes, Limit: 0 bytes",
  space: { usedBytes: 155744, limitBytes: 0 },
  account: { usedBytes: 389777359, limitBytes: 104857600, plan: "free" },
});

/** The node internals these tests drive; the fake host stands in for the network. */
interface NodeInternals {
  _address?: string;
  auth: unknown;
  config: { privateKey?: string };
  _serviceGraph: { track(context: ServiceContext): ServiceContext };
  _serviceContext?: ServiceContext;
  storageFull: { isFull: boolean };
  tc: { signIn(options?: unknown): Promise<unknown> };
  bootstrapStatus: unknown;
  registerPrimarySessionGrant(session: unknown): void;
  resolveBootstrapDecision(): Promise<{ action: "run"; mode: "repair" }>;
  runAccountBootstrap(): Promise<unknown[]>;
  writeBootstrapCompletionMarker(): Promise<void>;
  bootstrapAccountIfNeeded(): Promise<boolean>;
  createAccountRegistryServices(context: ServiceContext): { account: unknown; contexts: ServiceContext[] };
  writeManifestRegistryRecords(): Promise<void>;
  scheduleAccountRegistrySync(): void;
  pendingAccountRegistrySync?: { promise: Promise<void> };
  ownStorageFull: boolean;
  confirmedHostedSpaceIds: Set<string>;
}

function makeWasm(recap: Array<{ service: string; space: string; path: string; actions: string[] }>): IWasmBindings {
  // Only makeSpaceId, parseRecapFromSiwe and createSessionManager are reached;
  // the rest satisfy the binding's shape.
  const bindings = {
    invoke: mock(() => ({})),
    invokeAny: mock(() => ({})),
    prepareSession: mock(() => ({})),
    completeSessionSetup: mock(() => ({})),
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    createDelegation: mock(() => ({})),
    parseRecapFromSiwe: mock(() => recap),
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_x25519_from_seed: mock(() => ({ publicKey: new Uint8Array(), privateKey: new Uint8Array() })),
    vault_x25519_dh: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array()),
    vault_sha256: mock(() => new Uint8Array()),
    createSessionManager: () => ({
      createSessionKey: (id: string) => id,
      replaceSessionKey: (_jwk: object, keyId: string) => keyId,
      renameSessionKeyId: () => {},
      getDID: (keyId: string) => `did:key:${keyId}`,
      jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
    }),
  };
  return bindings as unknown as IWasmBindings;
}

/** A signed-in node wired to a fake TinyCloud host whose storage is full. */
function fullAccount(options: { grantsSpaceInfo?: boolean; grantsOtherSpaceInfo?: boolean; withoutRecap?: boolean } = {}) {
  const recap = [
    { service: "kv", space: SPACE_URI, path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    // Registry sync runs only for a session that can read the account index.
    { service: "sql", space: `tinycloud:pkh:eip155:1:${ADDRESS}:account`, path: "account", actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
    ...(options.grantsSpaceInfo === false
      ? []
      : [{ service: "space", space: SPACE_URI, path: "", actions: [SPACE_INFO] }]),
    ...(options.grantsOtherSpaceInfo
      ? [{ service: "space", space: OTHER_SPACE, path: "", actions: [SPACE_INFO] }]
      : []),
  ];
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: { getAddress: async () => ADDRESS, getChainId: async () => 1, signMessage: async () => "0xsig" },
    wasmBindings: makeWasm(recap),
  });
  const internals = node as unknown as NodeInternals;
  internals._address = ADDRESS;
  const session = {
    address: ADDRESS,
    chainId: 1,
    delegationHeader: { Authorization: "base-token" },
    delegationCid: "base-cid",
    jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
    sessionKey: "default",
    // No SIWE models a metadata-light restore: no recap to confirm grants from.
    siwe: options.withoutRecap ? undefined : [
      "tinycloud.test wants you to sign in with your Ethereum account:",
      ADDRESS,
      "",
      "Sign in.",
      "",
      "URI: https://tinycloud.test",
      "Version: 1",
      "Chain ID: 1",
      "Nonce: 32891756",
      "Issued At: 2026-05-05T00:00:00.000Z",
      "Expiration Time: 2999-01-01T00:00:00.000Z",
    ].join("\n"),
    spaceId: SPACE_URI,
    verificationMethod: "did:key:default",
  };
  internals.auth = { tinyCloudSession: session, lastActivationSkippedSpaceIds: [] };
  internals.registerPrimarySessionGrant(session);

  const host = { full: true, statusFails: false, writes: 0, reads: 0, statusReads: 0 };
  const fetch: FetchFunction = async (_url, init) => {
    const action = (init?.headers as Record<string, string>)["x-action"];
    if (action === SPACE_INFO) {
      if (host.statusFails) throw new TypeError("network down");
      host.statusReads += 1;
      return new Response(JSON.stringify({
        space: { usedBytes: 155744, limitBytes: host.full ? 0 : 50_000_000 },
        account: host.full
          ? { usedBytes: 389777359, limitBytes: 104857600, plan: "free" }
          : { usedBytes: 40_000_000, limitBytes: 104857600, plan: "free" },
        manageUrl: "https://account.tinycloud.xyz/storage",
      }), { status: 200 });
    }
    if (action === "tinycloud.kv/put") {
      host.writes += 1;
      return host.full
        ? new Response(REJECTION, { status: 402, statusText: "Payment Required" })
        : new Response("", { status: 200 });
    }
    host.reads += 1;
    return new Response(JSON.stringify({ name: "kept" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const context = internals._serviceGraph.track(new ServiceContext({
    hosts: ["https://tinycloud.test"],
    session: {
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId: SPACE_URI,
      verificationMethod: session.verificationMethod,
      jwk: session.jwk,
    },
    invoke: (_session, _service, _path, action) => ({ Authorization: "Bearer invocation", "x-action": action }),
    fetch,
  }));
  internals._serviceContext = context;
  const kv = new KVService({});
  kv.initialize(context);

  const events: StorageFullEvent[] = [];
  node.on("storage.full", (event) => events.push(event));
  return { node, internals, kv, host, events };
}

/** Have the full node refuse one write on `spaceId`, through a context the node's graph observes. */
async function rejectWriteOn(internals: NodeInternals, spaceId: string): Promise<void> {
  const context = internals._serviceGraph.track(new ServiceContext({
    hosts: ["https://tinycloud.test"],
    session: {
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy-session",
      spaceId,
      verificationMethod: "did:key:default",
      jwk: {},
    },
    invoke: () => ({ Authorization: "Bearer invocation" }),
    fetch: async () => new Response(REJECTION, { status: 402, statusText: "Payment Required" }),
  }));
  const kv = new KVService({});
  kv.initialize(context);
  const written = await kv.put("record", "v");
  expect(written.ok).toBe(false);
}

describe("TC-628: a full account", () => {
  test("storage.full fires once for every rejected write; reads keep working", async () => {
    const { kv, events, host } = fullAccount();

    const first = await kv.put("API_KEY", "v1");
    const second = await kv.put("OTHER", "v1");
    const read = await kv.get("API_KEY");

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe(ErrorCodes.STORAGE_QUOTA_EXCEEDED);
      expect(first.error.meta?.account).toEqual({ usedBytes: 389777359, limitBytes: 104857600, plan: "free" });
    }
    expect(read.ok).toBe(true);
    expect(host.writes).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      service: "kv",
      account: { usedBytes: 389777359, limitBytes: 104857600, plan: "free" },
    });
  });

  test("storage.status() reports the account, but only a successful write re-arms the own-storage event", async () => {
    const { node, kv, events, host } = fullAccount();
    await kv.put("API_KEY", "v1");

    const full = await node.storage.status();
    expect(full).toEqual({
      ok: true,
      data: {
        usedBytes: 155744,
        limitBytes: 0,
        account: { usedBytes: 389777359, limitBytes: 104857600, plan: "free" },
        plan: "free",
        state: "full",
        manageUrl: "https://account.tinycloud.xyz/storage",
      },
    });
    // Still full: no second banner.
    await kv.put("API_KEY", "v2");
    expect(events).toHaveLength(1);

    // Room reported by a status read does not end the episode.
    host.full = false;
    const roomy = await node.storage.status();
    expect(roomy.ok && roomy.data.state).toBe("ok");
    host.full = true;
    await kv.put("API_KEY", "v3");
    expect(events).toHaveLength(1);

    // A write that succeeds ends the episode; the next rejection announces itself.
    host.full = false;
    expect((await kv.put("API_KEY", "v4")).ok).toBe(true);
    host.full = true;
    await kv.put("API_KEY", "v5");
    expect(events).toHaveLength(2);
  });

  test("a status read that fails on the network neither ends nor re-arms the episode", async () => {
    const { node, kv, events, host } = fullAccount();
    await kv.put("API_KEY", "v1");
    expect(events).toHaveLength(1);

    host.statusFails = true;
    const failed = await node.storage.status();
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe("NETWORK_ERROR");

    // Still full: the rejected write does not announce again and the episode stays set.
    await kv.put("API_KEY", "v2");
    expect(events).toHaveLength(1);
    expect(node.storageEpisode.current()).toBeDefined();
  });

  test("storage.status() sends nothing when the session lacks tinycloud.space/info", async () => {
    const { node, host } = fullAccount({ grantsSpaceInfo: false });

    const status = await node.storage.status();

    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error.code).toBe(ErrorCodes.PERMISSION_DENIED);
    expect(status.error.meta).toEqual({ requiredAction: SPACE_INFO, resource: SPACE_URI });
    expect(host.statusReads).toBe(0);
  });

  test("storage.status() on a node without the usage read is STORAGE_STATUS_UNAVAILABLE", async () => {
    const { node, internals } = fullAccount();
    internals._serviceContext = internals._serviceGraph.track(new ServiceContext({
      hosts: ["https://tinycloud.test"],
      session: internals._serviceContext!.session,
      invoke: () => ({ Authorization: "Bearer invocation" }),
      fetch: async () => new Response(JSON.stringify({ spaceId: SPACE_URI }), { status: 200 }),
    }));

    const status = await node.storage.status();

    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error.code).toBe(ErrorCodes.STORAGE_STATUS_UNAVAILABLE);
  });

  test("sign-in skips bootstrap repair once a write was rejected for storage", async () => {
    const { internals, kv } = fullAccount();
    // Non-interactive signer, so bootstrap is the SDK's job.
    internals.config.privateKey = "0x" + "11".repeat(32);
    internals.resolveBootstrapDecision = async () => ({ action: "run", mode: "repair" });
    const runAccountBootstrap = mock(async () => []);
    const writeMarker = mock(async () => {});
    internals.runAccountBootstrap = runAccountBootstrap;
    internals.writeBootstrapCompletionMarker = writeMarker;

    // Storage has room: the repair runs.
    expect(await internals.bootstrapAccountIfNeeded()).toBe(true);
    expect(runAccountBootstrap).toHaveBeenCalledTimes(1);

    // A write is rejected for storage: the next sign-in does not repeat it.
    await kv.put("API_KEY", "v1");
    expect(await internals.bootstrapAccountIfNeeded()).toBe(false);
    expect(runAccountBootstrap).toHaveBeenCalledTimes(1);
    expect(writeMarker).toHaveBeenCalledTimes(1);
    expect(internals.bootstrapStatus).toEqual({ skipped: true, reason: "storage-full" });
  });

  test("sign-in schedules no account registry sync while the account's storage is full", async () => {
    const { internals, kv } = fullAccount();
    const ensure = mock(async () => ({ ok: true as const, data: undefined }));
    const writeRecords = mock(async () => {});
    internals.createAccountRegistryServices = (context) => ({ account: { index: { ensure } }, contexts: [context] });
    internals.writeManifestRegistryRecords = writeRecords;

    await kv.put("API_KEY", "v1");
    internals.scheduleAccountRegistrySync();
    await internals.pendingAccountRegistrySync?.promise;

    expect(ensure).not.toHaveBeenCalled();
    expect(writeRecords).not.toHaveBeenCalled();
  });

  test("a registry sync stops at the first write the full storage refuses", async () => {
    const { internals, kv } = fullAccount();
    // The index write is the one that discovers storage is full.
    const ensure = mock(async () => kv.put("index", "v"));
    const writeRecords = mock(async () => {});
    internals.createAccountRegistryServices = (context) => ({ account: { index: { ensure } }, contexts: [context] });
    internals.writeManifestRegistryRecords = writeRecords;

    internals.scheduleAccountRegistrySync();
    await internals.pendingAccountRegistrySync?.promise;

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(writeRecords).not.toHaveBeenCalled();
  });

  test("storage.status() fails closed when the session has no recap to confirm the grant", async () => {
    const { node, host } = fullAccount({ withoutRecap: true });

    const status = await node.storage.status();

    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error.code).toBe(ErrorCodes.PERMISSION_DENIED);
    expect(host.statusReads).toBe(0);
  });

  test("room on another owner's space does not clear this account's full state", async () => {
    const { node, internals, kv, host, events } = fullAccount({ grantsOtherSpaceInfo: true });
    await kv.put("API_KEY", "v1");

    host.full = false;
    const other = await node.storage.status({ space: OTHER_SPACE });
    expect(other.ok && other.data.state).toBe("ok");
    expect(internals.storageFull.isFull).toBe(true);

    host.full = true;
    await kv.put("API_KEY", "v2");
    expect(events).toHaveLength(1);
  });

  test("a rejection on another owner's space does not stop this account's repair", async () => {
    const { internals } = fullAccount();
    internals.config.privateKey = "0x" + "11".repeat(32);
    internals.resolveBootstrapDecision = async () => ({ action: "run", mode: "repair" });
    const runAccountBootstrap = mock(async () => []);
    internals.runAccountBootstrap = runAccountBootstrap;
    internals.writeBootstrapCompletionMarker = async () => {};

    await rejectWriteOn(internals, OTHER_SPACE);
    expect(internals.storageFull.isFull).toBe(true);

    expect(await internals.bootstrapAccountIfNeeded()).toBe(true);
    expect(runAccountBootstrap).toHaveBeenCalledTimes(1);
  });

  test("a full delegated space does not hide that the account's own storage is full", async () => {
    const { internals, kv, events } = fullAccount();
    internals.config.privateKey = "0x" + "11".repeat(32);
    internals.resolveBootstrapDecision = async () => ({ action: "run", mode: "repair" });
    const runAccountBootstrap = mock(async () => []);
    internals.runAccountBootstrap = runAccountBootstrap;
    internals.writeBootstrapCompletionMarker = async () => {};

    // Another owner's space (B) is full first, then the account's own (A).
    await rejectWriteOn(internals, OTHER_SPACE);
    expect(internals.ownStorageFull).toBe(false);
    const own = await kv.put("API_KEY", "v1");
    expect(own.ok).toBe(false);

    expect(internals.ownStorageFull).toBe(true);
    expect(await internals.bootstrapAccountIfNeeded()).toBe(false);
    expect(runAccountBootstrap).not.toHaveBeenCalled();
    // B's banner was shown for B; the account's own storage is a separate episode and announces itself.
    expect(events.map((e) => e.spaceId)).toEqual([OTHER_SPACE, SPACE_URI]);
  });

  test("room on the account's own space clears only the account; a full delegated space stays full", async () => {
    const { node, internals, kv, host } = fullAccount();
    await rejectWriteOn(internals, OTHER_SPACE);
    await kv.put("API_KEY", "v1");

    host.full = false;
    const status = await node.storage.status();
    expect(status.ok && status.data.state).toBe("ok");

    expect(internals.ownStorageFull).toBe(false);
    expect(internals.storageFull.isFull).toBe(true);
  });

  test("a registry sync through the real account services stops at the first SQL write the full storage refuses", async () => {
    const { internals } = fullAccount();
    const accountSpace = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;
    internals.confirmedHostedSpaceIds.add(accountSpace);
    const sqlRequests: Array<{ action: string; space: string | undefined }> = [];
    const shared = internals._serviceContext!;
    // The registry's scoped SQL context hits a node whose storage is full.
    internals._serviceContext = internals._serviceGraph.track(new ServiceContext({
      hosts: shared.hosts,
      session: shared.session!,
      invoke: (session, _service, _path, action) => ({ "x-action": action, "x-space": session.spaceId }),
      fetch: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        sqlRequests.push({ action: headers["x-action"]!, space: headers["x-space"] });
        return new Response(REJECTION, { status: 413, statusText: "Payload Too Large" });
      },
    }));
    const writeRecords = mock(async () => {});
    internals.writeManifestRegistryRecords = writeRecords;

    internals.scheduleAccountRegistrySync();
    await internals.pendingAccountRegistrySync?.promise.catch(() => {});

    expect(sqlRequests).toHaveLength(1);
    expect(sqlRequests[0]!.action.startsWith("tinycloud.sql/")).toBe(true);
    expect(sqlRequests[0]!.space).toBe(accountSpace);
    expect(internals.ownStorageFull).toBe(true);
    expect(writeRecords).not.toHaveBeenCalled();
  });
});

describe("TC-628: restoring a session", () => {
  /** A restore payload the real bindings verify: SIWE signed by ADDRESS's key, plus the light fields. */
  async function signedSession(wasm: NodeWasmBindings) {
    const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
    const manager = wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const address = await signer.getAddress();
    const chainId = await signer.getChainId();
    const spaceId = wasm.makeSpaceId(address, chainId, "default");
    const now = Date.now();
    const prepared = wasm.prepareSession({
      abilities: { kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put"] } },
      address,
      chainId,
      domain: "restore.test",
      issuedAt: new Date(now).toISOString(),
      expirationTime: new Date(now + 60 * 60_000).toISOString(),
      spaceId,
      jwk,
    });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    const light = {
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId,
      jwk,
      verificationMethod: manager.getDID("default"),
      tinycloudHosts: ["https://tinycloud.test"],
    };
    return { light, full: { ...light, address, chainId, siwe: prepared.siwe, signature } };
  }

  test("restoring the same owner without the optional metadata keeps the storage-full episode", async () => {
    const wasm = new NodeWasmBindings();
    const { light, full } = await signedSession(wasm);
    const node = new TinyCloudNode({ host: "https://tinycloud.test", wasmBindings: wasm });
    const internals = node as unknown as NodeInternals;

    await node.restoreSession(full);
    expect(node.address).toBeDefined();
    await rejectWriteOn(internals, full.spaceId);
    expect(internals.ownStorageFull).toBe(true);

    await node.restoreSession(light);
    expect(node.address).toBeUndefined();
    expect(internals.storageFull.isFull).toBe(true);
    expect(internals.ownStorageFull).toBe(true);
  });

  test("a metadata-light restore of a different account starts a new storage-full episode", async () => {
    const wasm = new NodeWasmBindings();
    const manager = wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const node = new TinyCloudNode({ host: "https://tinycloud.test", wasmBindings: wasm });
    const internals = node as unknown as NodeInternals;
    // No address, chain or SIWE: both restores look the same apart from the space.
    const restore = (spaceId: string) => node.restoreSession({
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy-session",
      spaceId,
      jwk,
      verificationMethod: manager.getDID("default"),
      tinycloudHosts: ["https://tinycloud.test"],
    });

    await restore(SPACE_URI);
    expect(node.address).toBeUndefined();
    await rejectWriteOn(internals, SPACE_URI);

    await restore(SPACE_URI);
    expect(internals.storageFull.isFull).toBe(true);

    await restore(OTHER_SPACE);
    expect(internals.storageFull.isFull).toBe(false);
  });

  test("signing out ends the storage-full episode", async () => {
    const wasm = new NodeWasmBindings();
    const { full } = await signedSession(wasm);
    const node = new TinyCloudNode({ host: "https://tinycloud.test", wasmBindings: wasm });
    const internals = node as unknown as NodeInternals;

    await node.restoreSession(full);
    await rejectWriteOn(internals, full.spaceId);
    expect(internals.storageFull.isFull).toBe(true);

    await node.signOut();
    expect(internals.storageFull.isFull).toBe(false);
  });

  test("signing in as a different account ends the storage-full episode", async () => {
    let address = ADDRESS;
    const node = new TinyCloudNode({
      host: "https://tinycloud.test",
      signer: { getAddress: async () => address, getChainId: async () => 1, signMessage: async () => "0xsig" },
      wasmBindings: makeWasm([]),
    });
    const internals = node as unknown as NodeInternals;
    internals._address = ADDRESS;
    let fullWhenSigningIn: boolean | undefined;
    internals.tc.signIn = async () => {
      fullWhenSigningIn = internals.storageFull.isFull;
      throw new Error("sign-in stopped after the account changed");
    };
    await rejectWriteOn(internals, SPACE_URI);
    expect(internals.storageFull.isFull).toBe(true);

    address = "0x00000000000000000000000000000000000000aa";
    await expect(node.signIn()).rejects.toThrow("sign-in stopped after the account changed");
    expect(fullWhenSigningIn).toBe(false);
  });

  test("restoring a different owner clears recorded requests; the same owner keeps them", async () => {
    const wasm = new NodeWasmBindings();
    const manager = wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const node = new TinyCloudNode({ host: "https://tinycloud.test", wasmBindings: wasm, requestLog: true });
    const restore = (spaceId: string) => node.restoreSession({
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy-session",
      spaceId,
      jwk,
      verificationMethod: manager.getDID("default"),
      tinycloudHosts: ["https://tinycloud.test"],
    });
    const recorder = Reflect.get(node, "_requestLog") as { record(event: object): void };
    const onClear = mock(() => {});

    await restore(SPACE_URI);
    node.requests!.onClear(onClear);
    recorder.record({
      v: 1, at: 0, service: "kv", op: "kv/get", path: "notes/a", space: "default",
      host: null, bytes: 3, durationMs: 1, attempts: 1, ok: true, code: "ok", source: "network",
    });
    const recorded = node.requests!.snapshot().length;
    expect(recorded).toBeGreaterThan(0);

    await restore(SPACE_URI);
    expect(node.requests!.snapshot()).toHaveLength(recorded);
    expect(onClear).not.toHaveBeenCalled();

    await restore(OTHER_SPACE);
    expect(node.requests!.snapshot()).toEqual([]);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
