import { describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  clearTinyCloudDebugLogs,
  disableTinyCloudDebug,
  enableTinyCloudDebug,
  getTinyCloudDebugLogs,
} from "./debug";
import { ServiceContext } from "./context";
import { KVService } from "./kv/KVService";
import { SQLService } from "./sql/SQLService";
import { projectAttemptDiagnostic } from "./diagnostics";

function createContext(telemetry?: ConstructorParameters<typeof ServiceContext>[0]["telemetry"]) {
  return new ServiceContext({
    invoke: () => ({}),
    hosts: ["https://node.tinycloud.xyz"],
    telemetry,
  });
}

describe("ServiceContext telemetry", () => {
  test("does not call telemetry callback by default", () => {
    const events: Array<[string, unknown]> = [];
    const context = createContext({ onEvent: (event, data) => events.push([event, data]) });

    context.emit("service.response", { duration: 12 });

    expect(events).toHaveLength(0);
  });

  test("calls telemetry callback when enabled", () => {
    const events: Array<[string, unknown]> = [];
    const context = createContext({
      enabled: true,
      onEvent: (event, data) => events.push([event, data]),
    });

    context.emit("service.response", { duration: 12 });

    expect(events).toEqual([["service.response", { duration: 12 }]]);
  });

  test("projects telemetry without changing subscriber payloads", () => {
    const telemetry: Array<[string, unknown]> = [];
    const subscribers: unknown[] = [];
    const context = createContext({
      enabled: true,
      onEvent: (event, data) => telemetry.push([event, data]),
    });
    const payload = { action: "read", secret: "subscriber-canary" };
    context.on("service.response", (data) => subscribers.push(data));

    context.emit("service.response", payload);

    expect(subscribers).toEqual([payload]);
    expect(subscribers[0]).toBe(payload);
    expect(telemetry).toEqual([
      ["service.response", {}],
    ]);
  });

  test("projects adversarial diagnostics without changing subscriber payloads", () => {
    const telemetry: Array<[string, unknown]> = [];
    const subscribers: unknown[] = [];
    const plaintext = "plaintext-canary";
    const ciphertext = "ciphertext-canary";
    const credential = "credential-canary";
    const rawCode = "raw-node-code-canary";
    const rawService = "raw-node-service-canary";
    const bytes = new Uint8Array([131, 137, 139]);
    const error = Object.assign(new Error("raw-node-error-canary"), {
      code: rawCode,
      service: rawService,
      status: 503,
      cause: { plaintext },
    });
    const payload = {
      status: 503,
      ok: false,
      url: `https://user:${credential}@node.tinycloud.test/${plaintext}?ciphertext=${ciphertext}`,
      error,
      bytes,
      buffer: bytes.buffer,
      nested: [{ plaintext, ciphertext, key: credential }],
      authorization: credential,
      ciphertext,
      plaintext,
      key: credential,
    };
    const context = createContext({
      enabled: true,
      onEvent: (event, data) => telemetry.push([event, data]),
    });
    context.on("service.response", (data) => subscribers.push(data));

    enableTinyCloudDebug({ persist: false });
    clearTinyCloudDebugLogs();
    try {
      context.emit("service.response", payload);

      expect(subscribers).toEqual([payload]);
      expect(subscribers[0]).toBe(payload);
      const expected = {
        status: 503,
        ok: false,
        url: "[REDACTED]",
        error: { status: 503 },
      };
      expect(telemetry).toEqual([["service.response", expected]]);
      expect(getTinyCloudDebugLogs()).toContainEqual(
        expect.objectContaining({ event: "service.response", data: expected }),
      );

      const captured = JSON.stringify({ telemetry, debug: getTinyCloudDebugLogs() });
      for (const canary of [
        plaintext,
        ciphertext,
        credential,
        rawCode,
        rawService,
        "raw-node-error-canary",
      ]) {
        expect(captured).not.toContain(canary);
      }
    } finally {
      disableTinyCloudDebug({ persist: false });
      clearTinyCloudDebugLogs();
    }
  });

  test("contains hostile diagnostics without changing subscriber payloads", () => {
    const telemetry: Array<[string, unknown]> = [];
    const subscribers: unknown[] = [];
    const canary = "diagnostic-throw-canary";
    const throwingGetter = Object.defineProperty({}, "status", {
      get() {
        throw new Error(canary);
      },
    });
    const throwingProxy = new Proxy({}, {
      get() {
        throw new Error(canary);
      },
      getPrototypeOf() {
        throw new Error(canary);
      },
    });
    const { proxy: revokedProxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostileError = Object.assign(new Error(canary), {
      code: canary,
      service: canary,
      cause: canary,
      status: 503,
    });
    const payloads = [
      {
        url: new URL(`https://user:${canary}@${canary}.invalid/${canary}`),
        error: hostileError,
        bytes: new Uint8Array([83, 69, 67, 82, 69, 84]),
        buffer: Buffer.from(canary),
        nested: [canary, new Uint8Array([1, 2, 3])],
      },
      new Uint8Array([83, 69, 67, 82, 69, 84]),
      Buffer.from(canary),
      new URL(`https://${canary}.invalid/${canary}`),
      hostileError,
      throwingGetter,
      throwingProxy,
      revokedProxy,
    ];
    const context = createContext({
      enabled: true,
      onEvent: (event, data) => telemetry.push([event, data]),
    });
    context.on("service.response", (data) => subscribers.push(data));

    enableTinyCloudDebug({ persist: false });
    clearTinyCloudDebugLogs();
    try {
      for (const payload of payloads) context.emit("service.response", payload);

      expect(subscribers).toHaveLength(payloads.length);
      subscribers.forEach((payload, index) => expect(payload).toBe(payloads[index]));
      expect(telemetry).toEqual([
        ["service.response", { url: "[REDACTED]", error: { status: 503 } }],
        ["service.response", "[REDACTED]"],
        ["service.response", "[REDACTED]"],
        ["service.response", {}],
        ["service.response", { status: 503 }],
        ["service.response", {}],
        ["service.response", "[REDACTED]"],
        ["service.response", "[REDACTED]"],
      ]);

      const captured = JSON.stringify({ telemetry, debug: getTinyCloudDebugLogs() });
      expect(captured).not.toContain(canary);
      expect(captured).not.toContain("83,69,67,82,69,84");
    } finally {
      disableTinyCloudDebug({ persist: false });
      clearTinyCloudDebugLogs();
    }
  });
});

describe("ServiceContext retirement", () => {
  test("keeps captured platform functions unusable, aborts their fetches, and isolates custom cleanup failures", async () => {
    let requestSignal: AbortSignal | undefined;
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    const context = new ServiceContext({
      invoke: () => ({}),
      hosts: ["https://node.tinycloud.xyz"],
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        requestSignal = init?.signal;
        started();
        requestSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    context.registerService("throws-on-sign-out", {
      config: {},
      initialize: () => undefined,
      onSessionChange: () => undefined,
      onSignOut: () => { throw new Error("custom cleanup failed"); },
    });
    const capturedFetch = context.fetch;
    const inFlight = capturedFetch("https://node.tinycloud.xyz/in-flight");
    await fetchStarted;
    const originalError = console.error;
    console.error = mock(() => undefined);
    try {
      expect(() => context.retire()).not.toThrow();
    } finally {
      console.error = originalError;
    }

    expect(requestSignal?.aborted).toBe(true);
    await expect(inFlight).rejects.toThrow("aborted");
    expect(context.abortSignal.aborted).toBe(true);
    context.abort();
    expect(context.abortSignal.aborted).toBe(true);
    await expect(capturedFetch("https://node.tinycloud.xyz/after")).rejects.toThrow(
      "Service graph has been retired",
    );
    expect(() => context.invoke({} as any, "kv", "after", "tinycloud.kv/get")).toThrow(
      "Service graph has been retired",
    );
  });
});

describe("physical diagnostic attempts", () => {
  function fixture(options: { enabled?: boolean; preflight?: "auth" | "fetch"; reject?: boolean; sinkThrows?: boolean } = {}) {
    const events: Array<[string, Record<string, unknown>]> = [];
    let dispatched = 0;
    const context = new ServiceContext({
      hosts: ["http://127.0.0.1:1"],
      invoke: () => {
        if (options.preflight === "auth") throw new Error("authorization-canary");
        return {};
      },
      invokeAny: () => ({}),
      fetch: async () => {
        dispatched++;
        if (options.reject) throw new Error("transport-canary");
        return new Response('{"rows":[],"columns":[]}', { headers: { "content-type": "application/json" } });
      },
      session: { delegationHeader: {}, delegationCid: "synthetic", spaceId: "synthetic", verificationMethod: "synthetic", jwk: {} },
      telemetry: {
        enabled: options.enabled ?? true,
        onEvent: (name, data) => {
          // ServiceContext has already projected this local diagnostic callback.
          if (name.startsWith("diagnostic.")) events.push([name, data as Record<string, unknown>]);
          if (options.sinkThrows) throw new Error("sink-secret-canary");
        },
      },
    });
    if (options.preflight === "fetch") {
      Object.defineProperty(context, "fetch", { get() { throw new Error("retired-canary"); } });
    }
    const kv = new KVService({});
    const sql = new SQLService({});
    kv.initialize(context);
    sql.initialize(context);
    return { kv, sql, context, events, dispatched: () => dispatched };
  }

  test("preflight failures are not dispatched mutation attempts", async () => {
    for (const preflight of ["auth", "fetch"] as const) {
      const f = fixture({ preflight });
      expect((await f.kv.put("key-canary", "value-canary")).ok).toBe(false);
      expect((await f.sql.query("SELECT 'sql-preflight-canary'")).ok).toBe(false);
      expect((await f.sql.execute("INSERT INTO synthetic VALUES (1)")).ok).toBe(false);
      expect(f.dispatched()).toBe(0);
      expect(f.events).toEqual([]);
    }
  });

  test("each dispatch has one matching finish, separate identities, and no payload", async () => {
    const f = fixture({ reject: true });
    await f.kv.put("key-canary", "value-canary");
    await f.kv.put("key-canary", "value-canary");
    expect(f.dispatched()).toBe(2);
    expect(f.events.map(([name]) => name)).toEqual([
      "diagnostic.attempt.start", "diagnostic.attempt.finish",
      "diagnostic.attempt.start", "diagnostic.attempt.finish",
    ]);
    expect(f.events[0]![1].attempt_id).toBe(f.events[1]![1].attempt_id);
    expect(f.events[2]![1].attempt_id).toBe(f.events[3]![1].attempt_id);
    expect(f.events[0]![1].attempt_id).not.toBe(f.events[2]![1].attempt_id);
    expect(f.events[1]![1]).toMatchObject({ service: "kv", action: "put", outcome: "error" });
    expect(JSON.stringify(f.events)).not.toContain("canary");
  });

  test("SQL responses and spans do not double count or consume the body", async () => {
    const f = fixture();
    const result = await f.sql.query("SELECT 'sql-canary'");
    expect(result.ok).toBe(true);
    expect(f.dispatched()).toBe(1);
    expect(f.events).toHaveLength(2);
    expect(f.events[1]![1]).toMatchObject({ service: "sql", action: "query", outcome: "response", status: 200 });
    expect(JSON.stringify(f.events)).not.toContain("sql-canary");
  });

  test("list and batch branches observe transport rather than logical response events", async () => {
    const f = fixture({ reject: true });
    await f.kv.list();
    await f.kv.batchPut([{ key: "private-key", value: "private-value" }]);
    await f.kv.batchGet(["private-key", "another-private-key"]);
    expect(f.dispatched()).toBe(3);
    expect(f.events.map(([name, data]) => [name, data.action])).toEqual([
      ["diagnostic.attempt.start", "list"], ["diagnostic.attempt.finish", "list"],
      ["diagnostic.attempt.start", "batchPut"], ["diagnostic.attempt.finish", "batchPut"],
      ["diagnostic.attempt.start", "batchGet"], ["diagnostic.attempt.finish", "batchGet"],
    ]);
  });

  test("disabled and throwing sinks preserve successful business behavior", async () => {
    const disabled = fixture({ enabled: false });
    expect((await disabled.kv.put("key", "value")).ok).toBe(true);
    expect(disabled.events).toEqual([]);
    const throwing = fixture({ sinkThrows: true });
    expect((await throwing.kv.put("key", "value")).ok).toBe(true);
    expect(throwing.events).toHaveLength(2);
  });

  test("retry projection preserves only explicit attempt linkage and rejects raw extras/getters", () => {
    const payload = { attempt_id: crypto.randomUUID(), service: "kv", action: "put", ordinal: 2, delay_ms: 50 };
    expect(projectAttemptDiagnostic("diagnostic.retry.scheduled", payload)).toEqual(payload);
    expect(projectAttemptDiagnostic("diagnostic.retry.scheduled", { ...payload, key: "secret" })).toBeUndefined();
    let read = false;
    expect(projectAttemptDiagnostic("diagnostic.retry.scheduled", {
      ...payload, get delay_ms() { read = true; return 50; },
    })).toBeUndefined();
    expect(read).toBe(false);
  });
});
