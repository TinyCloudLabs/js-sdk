import { describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  clearTinyCloudDebugLogs,
  disableTinyCloudDebug,
  enableTinyCloudDebug,
  getTinyCloudDebugLogs,
} from "./debug";
import { ServiceContext } from "./context";

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
