import { describe, expect, test } from "bun:test";
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
        url: "https://node.tinycloud.test",
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
});
