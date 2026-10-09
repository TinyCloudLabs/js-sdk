import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { replicationForProfile } from "./replication-registry.js";
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
  test("a stalled close is bounded to three seconds and concurrent drains share one promise", async () => {
    let release!: () => void;
    let closeCalls = 0;
    let requestedDelay = 0;
    registerReplication("stalled", control(() => {
      closeCalls += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    }));
    expect(replicationForProfile("stalled")).toBeDefined();
    const schedule = (callback: () => void, delayMs: number) => {
      requestedDelay = delayMs;
      callback();
      return undefined as unknown as NodeJS.Timeout;
    };
    const first = closeReplication(schedule);
    const second = closeReplication(schedule);
    expect(second).toBe(first);
    await first;
    expect(requestedDelay).toBe(3_000);
    expect(closeCalls).toBe(1);
    expect(registeredReplications().size).toBe(0);
    release();
  });
  test("a drain request also closes controllers registered during the active drain", async () => {
    let releaseA!: () => void;
    let closedB = false;
    const startedA = Promise.withResolvers<void>();
    registerReplication("A", control(() => {
      startedA.resolve();
      return new Promise<void>((resolve) => { releaseA = resolve; });
    }));
    const draining = closeReplication();
    await startedA.promise;
    registerReplication("B", control(async () => { closedB = true; }));
    const requestedDuringDrain = closeReplication();
    expect(requestedDuringDrain).toBe(draining);
    releaseA();
    await draining;
    expect(closedB).toBe(true);
    expect(registeredReplications().size).toBe(0);
  });
  test("built CLI exits successfully after a stalled controller drain timeout", () => {
    const mainEntry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
    const script = `
      const key = Symbol.for("@tinycloud/cli/replication-registry");
      const stalled = { close: () => new Promise(() => {}) };
      globalThis[key] = {
        controls: new Map([["stalled", stalled]]),
        allControls: new Set([stalled]),
        installedSignalHandlers: false,
        generation: 0
      };
      // A referenced interval proves the bounded shutdown exits the real child process.
      setInterval(() => {}, 1000);
      process.argv = [process.execPath, ${JSON.stringify(mainEntry)}, "completion", "bash"];
      await import(${JSON.stringify(mainEntry)});
    `;
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 4_500,
    });
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });
  test("built main and legacy bundles drain the shared registry instance", () => {
    const legacyEntry = fileURLToPath(new URL("../../dist/legacy-entry.js", import.meta.url));
    const mainEntry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
    const script = `
      const key = Symbol.for("@tinycloud/cli/replication-registry");
      let closed = 0;
      const control = { close: async () => { closed += 1; } };
      globalThis[key] = {
        controls: new Map([["legacy", control]]),
        allControls: new Set([control]),
        installedSignalHandlers: false
      };
      process.argv = [process.execPath, ${JSON.stringify(mainEntry)}, "completion", "bash"];
      await import(${JSON.stringify(legacyEntry)});
      await import(${JSON.stringify(mainEntry)});
      if (closed !== 1) throw new Error("expected built main bundle to drain legacy registry");
      process.stdout.write("closed once");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`built CLI exited ${result.status}: ${result.stderr}`);
    expect(result.stdout).toContain("closed once");
  });
});
