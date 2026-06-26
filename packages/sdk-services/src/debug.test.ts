import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearTinyCloudDebugLogs,
  disableTinyCloudDebug,
  enableTinyCloudDebug,
  getTinyCloudDebugLogs,
  tinyCloudDebugLogger,
  TinyCloudDebugLogger,
} from "./debug";
import { ServiceContext } from "./context";

const globalWithDebug = globalThis as typeof globalThis & {
  TinyCloud_debug?: boolean | string;
  enableTinyCloudDebug?: unknown;
  getTinyCloudDebugLogs?: unknown;
  window?: unknown;
  localStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
};
const originalConsoleDebug = console.debug;
const originalWindow = globalWithDebug.window;
const originalLocalStorage = globalWithDebug.localStorage;

beforeEach(() => {
  console.debug = () => {};
});

afterEach(() => {
  disableTinyCloudDebug({ persist: false });
  clearTinyCloudDebugLogs();
  globalWithDebug.TinyCloud_debug = false;
  Object.defineProperty(globalWithDebug, "window", {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalWithDebug, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
  });
  console.debug = originalConsoleDebug;
});

describe("TinyCloud debug logger", () => {
  test("is disabled by default", () => {
    const logger = new TinyCloudDebugLogger();

    expect(logger.log("test.event")).toBeUndefined();
    expect(logger.getLogs()).toHaveLength(0);
  });

  test("exposes console globals", () => {
    expect(typeof globalWithDebug.enableTinyCloudDebug).toBe("function");
    expect(typeof globalWithDebug.getTinyCloudDebugLogs).toBe("function");
  });

  test("keeps a 1000 event ring buffer", () => {
    const logger = new TinyCloudDebugLogger();
    logger.enable({ persist: false });
    logger.clear();

    for (let i = 0; i < 1005; i += 1) {
      logger.log("debug.event", { i });
    }

    const logs = logger.getLogs();
    expect(logs).toHaveLength(1000);
    expect(logs[0].data).toEqual({ i: 5 });
    expect(logs[999].data).toEqual({ i: 1004 });
  });

  test("records duration for timers", () => {
    const logger = new TinyCloudDebugLogger();
    logger.enable({ persist: false });
    logger.clear();

    const timer = logger.startTimer("operation");
    const event = timer.stop({ ok: true });

    expect(event?.event).toBe("operation.end");
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("persists the browser debug flag in localStorage", () => {
    const stored = new Map<string, string>();
    Object.defineProperty(globalWithDebug, "window", {
      configurable: true,
      value: globalThis,
    });
    Object.defineProperty(globalWithDebug, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });

    enableTinyCloudDebug();
    expect(stored.get("TinyCloud_debug")).toBe("true");

    disableTinyCloudDebug();
    expect(stored.has("TinyCloud_debug")).toBe(false);
  });

  test("captures ServiceContext events when debug is enabled", () => {
    enableTinyCloudDebug({ persist: false });
    clearTinyCloudDebugLogs();

    const context = new ServiceContext({
      invoke: () => ({}),
      hosts: ["https://node.tinycloud.xyz"],
    });

    context.emit("custom.event", { value: 1 });

    expect(getTinyCloudDebugLogs()).toEqual([
      expect.objectContaining({
        event: "custom.event",
        data: { value: 1 },
      }),
    ]);
  });

  test("captures fetch timing", async () => {
    enableTinyCloudDebug({ persist: false });
    clearTinyCloudDebugLogs();

    const context = new ServiceContext({
      invoke: () => ({}),
      hosts: ["https://node.tinycloud.xyz"],
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
        blob: async () => new Blob(),
      }),
    });

    await context.fetch("https://node.tinycloud.xyz/invoke", { method: "POST" });

    const logs = getTinyCloudDebugLogs();
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "sdk.fetch.end",
        durationMs: expect.any(Number),
        data: expect.objectContaining({
          ok: true,
          status: 200,
        }),
      }),
    );
  });

  test("global singleton enable writes debug events", () => {
    enableTinyCloudDebug({ persist: false });

    tinyCloudDebugLogger.log("singleton.event");

    expect(getTinyCloudDebugLogs()).toContainEqual(
      expect.objectContaining({ event: "singleton.event" }),
    );
  });
});
