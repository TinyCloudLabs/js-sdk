import { describe, expect, test } from "bun:test";
import type { ReplicationControl } from "@tinycloud/node-sdk";
import { closeReplication, registerReplication, registeredReplications } from "./replication-registry.js";

function control(close: () => Promise<void>): ReplicationControl {
  return {
    status: async () => [],
    sync: async () => {},
    purge: async () => ({ purged: [], failed: [] }),
    clearPending: async () => 0,
    close,
  };
}

async function verifySignalShutdown(signal: "SIGINT" | "SIGTERM", expectedCode: number): Promise<void> {
  const previousExit = process.exit;
  const previousListeners = process.listenerCount(signal);
  const exited = Promise.withResolvers<void>();
  const exits: number[] = [];
  let closed = false;
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    exited.resolve();
  }) as typeof process.exit;
  try {
    registerReplication("default", control(async () => { closed = true; }));
    expect(process.listenerCount(signal)).toBe(previousListeners + 1);
    process.emit(signal);
    await exited.promise;
    expect(closed).toBe(true);
    expect(exits).toEqual([expectedCode]);
    expect(registeredReplications().size).toBe(0);
    expect(process.listenerCount(signal)).toBe(previousListeners);
  } finally {
    process.exit = previousExit;
    await closeReplication();
  }
}

describe("replication registry shutdown", () => {
  test("installs no signal handler while the registry is empty", () => {
    expect(registeredReplications().size).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  test("SIGINT drains controllers before exiting 130", async () => {
    await verifySignalShutdown("SIGINT", 130);
  });

  test("normal command completion drains and unregisters controllers", async () => {
    let closed = false;
    registerReplication("default", control(async () => { closed = true; }));
    expect(registeredReplications().size).toBe(1);
    await closeReplication();
    expect(closed).toBe(true);
    expect(registeredReplications().size).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  test("SIGTERM drains controllers before exiting 143", async () => {
    await verifySignalShutdown("SIGTERM", 143);
  });
});
