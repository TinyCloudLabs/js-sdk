import { describe, expect, test } from "bun:test";

import { ServiceContext } from "../context";
import { parseStorageRejection } from "../errors";
import { KVService } from "../kv/KVService";
import { SQLService } from "../sql/SQLService";
import { DuckDbService } from "../duckdb/DuckDbService";
import { TinyCloudQuota } from "../quota";
import { ErrorCodes, TelemetryEvents, type FetchFunction, type StorageQuotaInfo } from "../types";
import { StorageFullMonitor, type StorageFullEvent } from "./StorageFullMonitor";
import { STORAGE_MANAGE_URL, parseStorageStatus, storageUsageState } from "./status";

const FULL_BODY = JSON.stringify({
  error: "storage_quota_exceeded",
  message: "Storage quota exceeded. Used: 155744 bytes, Limit: 0 bytes",
  space: { usedBytes: 155744, limitBytes: 0 },
  account: { usedBytes: 389777359, limitBytes: 104857600, plan: "free" },
});

describe("parseStorageRejection", () => {
  test("reads space and account numbers from the node's JSON body", () => {
    expect(parseStorageRejection(FULL_BODY)).toEqual({
      usedBytes: 155744,
      limitBytes: 0,
      account: { usedBytes: 389777359, limitBytes: 104857600, plan: "free" },
    });
  });

  test("a JSON body without account numbers carries only the space", () => {
    const body = JSON.stringify({
      error: "storage_limit_reached",
      message: "Write exceeds remaining storage. Used: 900 bytes, Limit: 1000 bytes",
      space: { usedBytes: 900, limitBytes: 1000 },
    });
    expect(parseStorageRejection(body)).toEqual({ usedBytes: 900, limitBytes: 1000 });
  });

  test("malformed account numbers are dropped, not passed through", () => {
    const body = JSON.stringify({
      error: "storage_quota_exceeded",
      space: { usedBytes: 1, limitBytes: 0 },
      account: { usedBytes: "389 MB", limitBytes: -1, plan: "free" },
    });
    expect(parseStorageRejection(body)).toEqual({ usedBytes: 1, limitBytes: 0 });
  });

  test("falls back to the old plain-text sentence, also inside a JSON message", () => {
    expect(parseStorageRejection("Storage quota exceeded. Used: 5 bytes, Limit: 0 bytes")).toEqual({
      usedBytes: 5,
      limitBytes: 0,
    });
    expect(
      parseStorageRejection(JSON.stringify({ message: "Storage quota exceeded. Used: 5 bytes, Limit: 0 bytes" })),
    ).toEqual({ usedBytes: 5, limitBytes: 0 });
  });

  test("a proxy page or an unrelated JSON error is not a storage rejection", () => {
    expect(parseStorageRejection("<html><body>413 Request Entity Too Large</body></html>")).toBeUndefined();
    expect(parseStorageRejection(JSON.stringify({ error: "payload_too_large" }))).toBeUndefined();
    expect(parseStorageRejection("null")).toBeUndefined();
  });
});

/**
 * A fake node whose space is full: every KV put is refused with the node's
 * structured 402, every read succeeds. `free()` models the owner freeing space.
 */
function fullSpaceNode(spaceId = "tinycloud:pkh:eip155:1:0xabc:secrets") {
  let full = true;
  let puts = 0;
  let gets = 0;
  const fetch: FetchFunction = async (_url, init) => {
    const action = (init?.headers as Record<string, string>)["x-action"];
    if (action === "tinycloud.kv/put") {
      puts += 1;
      return full
        ? new Response(FULL_BODY, { status: 402, statusText: "Payment Required" })
        : new Response("", { status: 200 });
    }
    gets += 1;
    return new Response(JSON.stringify({ value: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const context = new ServiceContext({
    hosts: ["https://node.test"],
    session: {
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy",
      spaceId,
      verificationMethod: "did:key:test",
      jwk: {},
    },
    invoke: (_session, _service, _path, action) => ({ Authorization: "Bearer x", "x-action": action }),
    fetch,
  });
  const kv = new KVService({});
  context.registerService("kv", kv);
  kv.initialize(context);
  return {
    context,
    kv,
    free: () => {
      full = false;
    },
    counts: () => ({ puts, gets }),
  };
}

describe("StorageFullMonitor on a full space", () => {
  test("the first rejection emits storage.full once, with the account numbers; reads keep working", async () => {
    const node = fullSpaceNode();
    const monitor = new StorageFullMonitor();
    monitor.observe(node.context);
    const events: StorageFullEvent[] = [];
    const contextEvents: unknown[] = [];
    monitor.on((event) => events.push(event));
    node.context.on(TelemetryEvents.STORAGE_FULL, (event) => contextEvents.push(event));

    const first = await node.kv.put("API_KEY", "v1");
    const second = await node.kv.put("API_KEY", "v2");
    const read = await node.kv.get("API_KEY");

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe(ErrorCodes.STORAGE_QUOTA_EXCEEDED);
    expect(first.error.meta).toMatchObject({
      status: 402,
      usedBytes: 155744,
      limitBytes: 0,
      account: { usedBytes: 389777359, limitBytes: 104857600, plan: "free" },
    });
    expect(read.ok).toBe(true);
    expect(monitor.isFull).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      service: "kv",
      usedBytes: 155744,
      limitBytes: 0,
      account: { usedBytes: 389777359, limitBytes: 104857600, plan: "free" },
    });
    expect(events[0].error.code).toBe(ErrorCodes.STORAGE_QUOTA_EXCEEDED);
    // The same event goes through the context's emit, for telemetry and debug logs.
    expect(contextEvents).toEqual([events[0]]);
  });

  test("one event across several contexts; clear() re-arms it", async () => {
    const a = fullSpaceNode();
    const b = fullSpaceNode();
    const monitor = new StorageFullMonitor();
    monitor.observe(a.context);
    monitor.observe(b.context);
    const events: StorageFullEvent[] = [];
    monitor.on((event) => events.push(event));

    await a.kv.put("x", "1");
    await b.kv.put("y", "1");
    expect(events).toHaveLength(1);

    monitor.clear();
    expect(monitor.isFull).toBe(false);
    await b.kv.put("y", "2");
    expect(events).toHaveLength(2);
  });

  test("clear() ends the own episode and forgets the rejection", async () => {
    const node = fullSpaceNode("tinycloud:pkh:eip155:1:0xaaa:default");
    const monitor = new StorageFullMonitor(
      (spaceId) => spaceId.split(":").slice(0, 5).join(":"),
      () => "tinycloud:pkh:eip155:1:0xaaa",
    );
    monitor.observe(node.context);
    const episodes: boolean[] = [];
    monitor.onEpisode(() => episodes.push(monitor.rejection !== undefined));

    await node.kv.put("x", "1");
    expect(monitor.rejection).toBeDefined();

    monitor.clear();
    expect(monitor.rejection).toBeUndefined();
    expect(episodes).toEqual([true, false]);
  });

  test("other failures and a throwing handler do not trip or break it", async () => {
    const node = fullSpaceNode();
    const monitor = new StorageFullMonitor();
    monitor.observe(node.context);
    const originalError = console.error;
    console.error = () => {};
    try {
      monitor.on(() => {
        throw new Error("banner bug");
      });
      node.context.emit(TelemetryEvents.SERVICE_ERROR, {
        service: "kv",
        error: { code: ErrorCodes.NETWORK_ERROR, message: "down", service: "kv" },
      });
      expect(monitor.isFull).toBe(false);

      const result = await node.kv.put("x", "1");
      expect(result.ok).toBe(false);
      expect(monitor.isFull).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("own storage is one episode, ended only by a successful own write; delegated owners emit once each", async () => {
    const delegated = fullSpaceNode("tinycloud:pkh:eip155:1:0xbbb:shared");
    const own = fullSpaceNode("tinycloud:pkh:eip155:1:0xaaa:default");
    const monitor = new StorageFullMonitor(
      (spaceId) => spaceId.split(":").slice(0, 5).join(":"),
      () => "tinycloud:pkh:eip155:1:0xaaa",
    );
    monitor.observe(delegated.context);
    monitor.observe(own.context);
    const events: StorageFullEvent[] = [];
    monitor.on((event) => events.push(event));
    const episodes: boolean[] = [];
    monitor.onEpisode(() => episodes.push(monitor.rejection !== undefined));

    await delegated.kv.put("x", "1");
    expect(events.map((event) => event.spaceId)).toEqual(["tinycloud:pkh:eip155:1:0xbbb:shared"]);
    expect(monitor.rejection).toBeUndefined();

    await own.kv.put("y", "1");
    expect(monitor.rejection?.spaceId).toBe("tinycloud:pkh:eip155:1:0xaaa:default");
    expect(episodes).toEqual([true]);
    expect(events).toHaveLength(2);

    // Same episode: no second emit. A status read clears best-effort state but not the episode.
    await own.kv.put("y", "2");
    monitor.clearFor("tinycloud:pkh:eip155:1:0xaaa:default");
    await own.kv.put("y", "3");
    expect(events).toHaveLength(2);
    expect(monitor.rejection).toBeDefined();
    expect(episodes).toEqual([true]);

    // A read that succeeds does not end the episode: only a committing write does.
    expect((await own.kv.get("y")).ok).toBe(true);
    expect(monitor.rejection).toBeDefined();

    // The delegated owner was never cleared, so it stays silent; cleared, it emits again.
    await delegated.kv.put("x", "2");
    expect(events).toHaveLength(2);
    monitor.clearFor("tinycloud:pkh:eip155:1:0xbbb:shared");
    await delegated.kv.put("x", "3");
    expect(events).toHaveLength(3);

    own.free();
    expect((await own.kv.put("y", "4")).ok).toBe(true);
    expect(monitor.rejection).toBeUndefined();
    expect(episodes).toEqual([true, false]);
    expect(monitor.isFullFor("tinycloud:pkh:eip155:1:0xaaa:account")).toBe(false);
    expect(monitor.isFullFor("tinycloud:pkh:eip155:1:0xbbb:shared")).toBe(true);

    delegated.free();
    expect((await delegated.kv.put("x", "4")).ok).toBe(true);
    expect(monitor.isFull).toBe(false);
  });

  test("onDelegated fires once per delegated owner and never for the own episode", async () => {
    const delegated = fullSpaceNode("tinycloud:pkh:eip155:1:0xbbb:shared");
    const own = fullSpaceNode("tinycloud:pkh:eip155:1:0xaaa:default");
    const monitor = new StorageFullMonitor(
      (spaceId) => spaceId.split(":").slice(0, 5).join(":"),
      () => "tinycloud:pkh:eip155:1:0xaaa",
    );
    monitor.observe(delegated.context);
    monitor.observe(own.context);
    let delegatedCount = 0;
    monitor.onDelegated(() => {
      delegatedCount += 1;
    });

    await own.kv.put("y", "1");
    expect(delegatedCount).toBe(0);

    await delegated.kv.put("x", "1");
    await delegated.kv.put("x", "2");
    expect(delegatedCount).toBe(1);

    monitor.clearFor("tinycloud:pkh:eip155:1:0xbbb:shared");
    await delegated.kv.put("x", "3");
    expect(delegatedCount).toBe(2);
  });

  test("a network failure during the own episode neither ends nor re-emits it", async () => {
    const node = fullSpaceNode("tinycloud:pkh:eip155:1:0xaaa:default");
    const monitor = new StorageFullMonitor(
      (spaceId) => spaceId.split(":").slice(0, 5).join(":"),
      () => "tinycloud:pkh:eip155:1:0xaaa",
    );
    monitor.observe(node.context);
    const events: StorageFullEvent[] = [];
    monitor.on((event) => events.push(event));
    const episodes: boolean[] = [];
    monitor.onEpisode(() => episodes.push(monitor.rejection !== undefined));

    await node.kv.put("y", "1");
    expect(events).toHaveLength(1);

    // A write that failed on the network is not a committed write.
    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "kv", action: "put", ok: false });
    node.context.emit(TelemetryEvents.SERVICE_ERROR, {
      service: "kv",
      error: { code: ErrorCodes.NETWORK_ERROR, message: "down", service: "kv" },
    });
    expect(monitor.rejection).toBeDefined();
    expect(episodes).toEqual([true]);

    // Still the same episode: a later full rejection does not emit again.
    expect((await node.kv.put("y", "2")).ok).toBe(false);
    expect(events).toHaveLength(1);
    expect(monitor.rejection).toBeDefined();

    // A committed own write ends it.
    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "kv", action: "put", ok: true });
    expect(monitor.rejection).toBeUndefined();
    expect(episodes).toEqual([true, false]);
  });

  test("a successful delete or get does not end the own episode; a committed batchPut does", async () => {
    const node = fullSpaceNode("tinycloud:pkh:eip155:1:0xaaa:default");
    const monitor = new StorageFullMonitor(
      (spaceId) => spaceId.split(":").slice(0, 5).join(":"),
      () => "tinycloud:pkh:eip155:1:0xaaa",
    );
    monitor.observe(node.context);
    const episodes: boolean[] = [];
    monitor.onEpisode(() => episodes.push(monitor.rejection !== undefined));

    await node.kv.put("y", "1");
    expect(monitor.rejection).toBeDefined();

    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "kv", action: "delete", ok: true });
    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "kv", action: "get", ok: true });
    expect(monitor.rejection).toBeDefined();
    expect(episodes).toEqual([true]);

    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "kv", action: "batchPut", ok: true });
    expect(monitor.rejection).toBeUndefined();
    expect(episodes).toEqual([true, false]);
  });

  /** An own full space with one rejection observed, so the own episode is on. */
  async function ownFullEpisode() {
    const node = fullSpaceNode("tinycloud:pkh:eip155:1:0xaaa:default");
    const monitor = new StorageFullMonitor(
      (spaceId) => spaceId.split(":").slice(0, 5).join(":"),
      () => "tinycloud:pkh:eip155:1:0xaaa",
    );
    monitor.observe(node.context);
    const episodes: boolean[] = [];
    monitor.onEpisode(() => episodes.push(monitor.rejection !== undefined));
    await node.kv.put("y", "1");
    expect(monitor.rejection).toBeDefined();
    return { node, monitor, episodes };
  }

  test("a committed vault put ends the own episode; a vault get does not", async () => {
    const { node, monitor, episodes } = await ownFullEpisode();

    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "vault", action: "get", ok: true });
    expect(monitor.rejection).toBeDefined();
    expect(episodes).toEqual([true]);

    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "vault", action: "put", ok: true });
    expect(monitor.rejection).toBeUndefined();
    expect(episodes).toEqual([true, false]);
  });

  test("a committed SQL execute ends the own episode", async () => {
    const { node, monitor, episodes } = await ownFullEpisode();

    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "sql", action: "execute", ok: true });
    expect(monitor.rejection).toBeUndefined();
    expect(episodes).toEqual([true, false]);
  });

  test("a committed DuckDB execute ends the own episode", async () => {
    const { node, monitor, episodes } = await ownFullEpisode();

    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "duckdb", action: "execute", ok: true });
    expect(monitor.rejection).toBeUndefined();
    expect(episodes).toEqual([true, false]);
  });

  test("a committed write on another owner's space leaves the own episode on", async () => {
    const { node, monitor, episodes } = await ownFullEpisode();
    node.context.setSession({
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy",
      spaceId: "tinycloud:pkh:eip155:1:0xbbb:default",
      verificationMethod: "did:key:test",
      jwk: {},
    });

    node.context.emit(TelemetryEvents.SERVICE_RESPONSE, { service: "kv", action: "put", ok: true });
    expect(monitor.rejection).toBeDefined();
    expect(episodes).toEqual([true]);
  });

  test("a rejection whose space is unknown counts for every owner", async () => {
    const node = fullSpaceNode();
    node.context.setSession(null);
    const monitor = new StorageFullMonitor();
    monitor.observe(node.context);
    node.context.emit(TelemetryEvents.SERVICE_ERROR, {
      service: "kv",
      error: { code: ErrorCodes.STORAGE_QUOTA_EXCEEDED, message: "full", service: "kv" },
    });

    expect(monitor.isFullFor("tinycloud:pkh:eip155:1:0xaaa:default")).toBe(true);
    monitor.clearFor(undefined);
    expect(monitor.isFull).toBe(false);
  });
});

describe("storage status", () => {
  test("state comes from the account totals when the node has them", () => {
    expect(
      parseStorageStatus({
        space: { usedBytes: 155744, limitBytes: 0 },
        account: { usedBytes: 50, limitBytes: 100, plan: "paid" },
        manageUrl: "https://account.tinycloud.xyz/storage",
      }),
    ).toEqual({
      usedBytes: 155744,
      limitBytes: 0,
      account: { usedBytes: 50, limitBytes: 100, plan: "paid" },
      plan: "paid",
      state: "ok",
      manageUrl: "https://account.tinycloud.xyz/storage",
    });
  });

  test("without account totals the space decides; a null limit is unlimited", () => {
    expect(parseStorageStatus({ space: { usedBytes: 10, limitBytes: 10 } })).toMatchObject({
      state: "full",
      manageUrl: STORAGE_MANAGE_URL,
    });
    expect(parseStorageStatus({ space: { usedBytes: 10, limitBytes: null } })).toMatchObject({
      limitBytes: null,
      state: "ok",
    });
  });

  test("nearly full from 90% of the limit", () => {
    expect(storageUsageState(89, 100)).toBe("ok");
    expect(storageUsageState(90, 100)).toBe("nearly_full");
    expect(storageUsageState(100, 100)).toBe("full");
    expect(storageUsageState(1, 0)).toBe("full");
  });

  test("a body without space numbers, or a non-https manage URL, is not trusted", () => {
    expect(parseStorageStatus({ spaceId: "x" })).toBeUndefined();
    expect(parseStorageStatus({ space: { usedBytes: -1, limitBytes: 1 } })).toBeUndefined();
    expect(
      parseStorageStatus({ space: { usedBytes: 1, limitBytes: 2 }, manageUrl: "javascript:alert(1)" })?.manageUrl,
    ).toBe(STORAGE_MANAGE_URL);
  });
});

const LIMIT_BODY = JSON.stringify({
  error: "storage_limit_reached",
  message: "Write exceeds remaining storage. Used: 900 bytes, Limit: 1000 bytes",
  space: { usedBytes: 900, limitBytes: 1000 },
  account: { usedBytes: 99_000_000, limitBytes: 104857600, plan: "free" },
});

function contextAnswering(status: number, body: string): ServiceContext {
  return new ServiceContext({
    hosts: ["https://node.test"],
    session: {
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    invoke: () => ({ Authorization: "Bearer x" }),
    invokeAny: () => ({ Authorization: "Bearer x" }),
    fetch: async () => new Response(body, { status, statusText: "Payload Too Large" }),
  });
}

describe("SQL and DuckDB storage 413", () => {
  const services: Array<{ name: string; code: string; make: () => SQLService | DuckDbService }> = [
    { name: "sql", code: ErrorCodes.SQL_RESPONSE_TOO_LARGE, make: () => new SQLService() },
    { name: "duckdb", code: ErrorCodes.DUCKDB_RESPONSE_TOO_LARGE, make: () => new DuckDbService() },
  ];

  test.each(services)("$name: the node's storage 413 is STORAGE_LIMIT_REACHED with the account, and fires storage.full", async ({ name, make }) => {
    const context = contextAnswering(413, LIMIT_BODY);
    const monitor = new StorageFullMonitor();
    monitor.observe(context);
    const events: StorageFullEvent[] = [];
    monitor.on((event) => events.push(event));
    const service = make();
    service.initialize(context);

    const result = await service.execute("INSERT INTO notes (body) VALUES (?)", ["x".repeat(200)]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.STORAGE_LIMIT_REACHED);
    expect(result.error.service).toBe(name);
    expect(result.error.meta).toMatchObject({
      status: 413,
      usedBytes: 900,
      limitBytes: 1000,
      account: { usedBytes: 99_000_000, limitBytes: 104857600, plan: "free" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ service: name, spaceId: "tinycloud:pkh:eip155:1:0xabc:default" });
  });

  test.each(services)("$name: a 413 without the node's storage body stays a response-size error", async ({ code, make }) => {
    const context = contextAnswering(413, "<html><body>413 Request Entity Too Large</body></html>");
    const monitor = new StorageFullMonitor();
    monitor.observe(context);
    const service = make();
    service.initialize(context);

    const result = await service.execute("SELECT * FROM big");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(monitor.isFull).toBe(false);
  });
});

describe("deprecated quota API (kept for minor-release compatibility)", () => {
  test("TinyCloudQuota still forwards a quota error to onUpgradeRequired", () => {
    const seen: StorageQuotaInfo[] = [];
    const quota = new TinyCloudQuota({ onUpgradeRequired: (info) => seen.push(info) });
    const info: StorageQuotaInfo = { usedBytes: 1, limitBytes: 0, service: "kv" };

    quota.handleQuotaError(info);

    expect(seen).toEqual([info]);
    expect(quota.available).toBe(false);
  });
});
