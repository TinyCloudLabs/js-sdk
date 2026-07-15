import { describe, expect, test } from "bun:test";
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
      ["service.response", { action: "read", secret: "[REDACTED]" }],
    ]);
  });
});
