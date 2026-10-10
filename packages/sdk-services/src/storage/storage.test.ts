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
function fullSpaceNode() {
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
      spaceId: "tinycloud:pkh:eip155:1:0xabc:secrets",
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
});

describe("storage status", () => {
  test("state comes from the account totals when the node has them", () => {
    expect(
      parseStorageStatus({
        space: { usedBytes: 155744, limitBytes: 0 },
        account: { usedBytes: 50, limitBytes: 100, plan: "paid" },
        manageUrl: "https://account.tinycloud.xyz/billing",
      }),
    ).toEqual({
      usedBytes: 155744,
      limitBytes: 0,
      account: { usedBytes: 50, limitBytes: 100, plan: "paid" },
      plan: "paid",
      state: "ok",
      manageUrl: "https://account.tinycloud.xyz/billing",
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
