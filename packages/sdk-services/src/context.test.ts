import { describe, expect, mock, test } from "bun:test";
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
