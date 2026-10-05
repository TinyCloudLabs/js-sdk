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

import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const SPACE_URI = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
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
  bootstrapStatus: unknown;
  registerPrimarySessionGrant(session: unknown): void;
  resolveBootstrapDecision(): Promise<{ action: "run"; mode: "repair" }>;
  runAccountBootstrap(): Promise<unknown[]>;
  writeBootstrapCompletionMarker(): Promise<void>;
  bootstrapAccountIfNeeded(): Promise<boolean>;
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
function fullAccount(options: { grantsSpaceInfo?: boolean } = {}) {
  const recap = [
    { service: "kv", space: SPACE_URI, path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    ...(options.grantsSpaceInfo === false
      ? []
      : [{ service: "space", space: SPACE_URI, path: "", actions: [SPACE_INFO] }]),
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
    siwe: [
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

  const host = { full: true, writes: 0, reads: 0, statusReads: 0 };
  const fetch: FetchFunction = async (_url, init) => {
    const action = (init?.headers as Record<string, string>)["x-action"];
    if (action === SPACE_INFO) {
      host.statusReads += 1;
      return new Response(JSON.stringify({
        space: { usedBytes: 155744, limitBytes: host.full ? 0 : 50_000_000 },
        account: host.full
          ? { usedBytes: 389777359, limitBytes: 104857600, plan: "free" }
          : { usedBytes: 40_000_000, limitBytes: 104857600, plan: "free" },
        manageUrl: "https://account.tinycloud.xyz/billing",
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

  test("storage.status() reports the account, and re-arms the event once there is room", async () => {
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
        manageUrl: "https://account.tinycloud.xyz/billing",
      },
    });
    // Still full: no second banner.
    await kv.put("API_KEY", "v2");
    expect(events).toHaveLength(1);

    host.full = false;
    const roomy = await node.storage.status();
    expect(roomy.ok && roomy.data.state).toBe("ok");

    host.full = true;
    await kv.put("API_KEY", "v3");
    expect(events).toHaveLength(2);
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
});
