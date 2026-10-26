import { mkdtempSync, rmSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";

// Every store directory and tool home of this file lives under one temp dir.
const TEST_HOME = mkdtempSync("/var/tmp/tc2096.");
const PREVIOUS_ENV = { HOME: process.env.HOME, BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR };
process.env.HOME = TEST_HOME;
process.env.BUN_INSTALL_CACHE_DIR = TEST_HOME;
if (!process.env.HOME.startsWith("/var/tmp/tc2096.")) throw new Error("test home is not a temp dir");

import { FakeNode, newStore } from "../test/fixtures.js";
import { REPAIR_BACKOFF_BASE_MS, REPAIR_MAX_TRIES, Replica } from "./engine.js";

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  for (const [name, value] of Object.entries(PREVIOUS_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const MINUTE = 60_000;

/** A replica whose value for `notes/a` cannot be verified (the node says it is gone). */
async function failingReplica() {
  expect(process.env.HOME).toBe(TEST_HOME);
  const node = new FakeNode();
  node.put("notes/a", "v1");
  node.tamper.set("notes/a", { missing: true });
  let now = Date.now();
  const store = await newStore(mkdtempSync(`${TEST_HOME}/store.`));
  const replica = new Replica({ store, transport: node, now: () => now });
  return {
    node,
    store,
    replica,
    advance: (ms: number) => void (now += ms),
  };
}

describe("repair retries", () => {
  test("a value that cannot be verified is retried with growing gaps and given up after five tries", async () => {
    const { node, replica, advance } = await failingReplica();

    // Sync 1: the page's own fetch, then repair try 1.
    await replica.sync();
    expect(node.fetchCalls).toBe(2);
    // Try 2 follows at once (no wait after the first failure).
    await replica.sync();
    expect(node.fetchCalls).toBe(3);
    // Backing off for one minute: syncs in between fetch nothing.
    await replica.sync();
    advance(REPAIR_BACKOFF_BASE_MS - 1);
    await replica.sync();
    expect(node.fetchCalls).toBe(3);
    // Try 3, then two minutes.
    advance(1);
    await replica.sync();
    expect(node.fetchCalls).toBe(4);
    advance(2 * MINUTE - 1);
    await replica.sync();
    expect(node.fetchCalls).toBe(4);
    // Try 4, then four minutes.
    advance(1);
    await replica.sync();
    expect(node.fetchCalls).toBe(5);
    advance(4 * MINUTE - 1);
    await replica.sync();
    expect(node.fetchCalls).toBe(5);
    // Try 5 is the last.
    advance(1);
    await replica.sync();
    expect(node.fetchCalls).toBe(1 + REPAIR_MAX_TRIES);

    // Given up: no wait is long enough.
    for (let i = 0; i < 3; i += 1) {
      advance(5 * MINUTE);
      const report = await replica.sync();
      expect(report.contentMissing).toBe(1);
      expect(report.repaired).toBe(0);
    }
    expect(node.fetchCalls).toBe(1 + REPAIR_MAX_TRIES);
    // The value stays content_missing (reads fall through to the network).
    expect((await replica.get("notes/a")).status).toBe("content_missing");
  });

  test("a value that verifies after two tries is removed and stops being retried", async () => {
    const { node, replica, advance } = await failingReplica();

    await replica.sync(); // page fetch + try 1 fail
    node.tamper.clear();
    const report = await replica.sync(); // try 2 verifies
    expect(report.repaired).toBe(1);
    expect(report.contentMissing).toBe(0);
    const calls = node.fetchCalls;
    expect(calls).toBe(3);

    for (let i = 0; i < 3; i += 1) {
      advance(5 * MINUTE);
      await replica.sync();
    }
    expect(node.fetchCalls).toBe(calls);

    // Its state is gone: the same key with a new value that fails again is retried at once,
    // and gets its own five tries.
    node.put("notes/a", "v2");
    node.tamper.set("notes/a", { missing: true });
    await replica.sync(); // page fetch + try 1
    expect(node.fetchCalls).toBe(calls + 2);
    await replica.sync(); // try 2 with no wait
    expect(node.fetchCalls).toBe(calls + 3);
  });

  test("a pending set that is all backing off or given up issues zero fetches", async () => {
    const { node, replica, advance } = await failingReplica();
    node.put("notes/b", "v1");
    node.tamper.set("notes/b", { missing: true });

    await replica.sync(); // page fetch + try 1 of both
    await replica.sync(); // try 2 of both (one batch), then one minute of backoff
    const afterTwo = node.fetchCalls;
    await replica.sync();
    expect(node.fetchCalls).toBe(afterTwo);

    // Walk both to the cap.
    for (const wait of [MINUTE, 2 * MINUTE, 4 * MINUTE]) {
      advance(wait);
      await replica.sync();
    }
    expect(node.fetchCalls).toBe(afterTwo + 3);
    const done = node.fetchCalls;
    advance(5 * MINUTE);
    const report = await replica.sync();
    expect(report.contentMissing).toBe(2);
    expect(node.fetchCalls).toBe(done);
  });
});
