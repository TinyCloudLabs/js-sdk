import { describe, expect, test } from "bun:test";
import { closeReplication, registerReplication, registeredReplications } from "./replication-registry.js";
import type { ReplicationControl } from "@tinycloud/node-sdk";

const control = (close: () => void | Promise<void>) => ({ close }) as unknown as ReplicationControl;
const delayedScheduler = (callbacks: Array<() => void>) => (callback: () => void, delayMs: number) => {
  expect(delayMs).toBe(3_000);
  callbacks.push(callback);
  return {} as NodeJS.Timeout;
};

describe("replication registry shutdown", () => {
  test("closes a registration made between drain settlement and close finalization", async () => {
    let lateClosed = false;
    registerReplication("first", control(() => undefined));
    const closing = closeReplication();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    registerReplication("late", control(() => { lateClosed = true; }));
    const repeatedClose = closeReplication();

    expect(repeatedClose).toBe(closing);
    expect(await closing).toBe(false);
    expect(lateClosed).toBe(true);
    expect(registeredReplications().size).toBe(0);
  });

  test("uses one timeout budget for stalled generations", async () => {
    const callbacks: Array<() => void> = [];
    let firstClosed = 0;
    let secondClosed = 0;
    registerReplication("stalled-first", control(() => new Promise<void>(() => { firstClosed += 1; })));
    const closing = closeReplication(delayedScheduler(callbacks));
    await Promise.resolve();
    registerReplication("stalled-second", control(() => new Promise<void>(() => { secondClosed += 1; })));
    callbacks[0]!();

    expect(await closing).toBe(true);
    expect(callbacks).toHaveLength(1);
    expect(firstClosed).toBe(1);
    expect(secondClosed).toBe(1);
    expect(registeredReplications().size).toBe(0);
  });

  test("removes signal handlers after a mid-drain registration empties the registry", async () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    registerReplication("initial", control(() => {
      registerReplication("during-drain", control(() => undefined));
    }));

    await closeReplication();

    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });
});
