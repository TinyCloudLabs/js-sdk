import { mkdtempSync, rmSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";

// Every store directory and tool home of this file lives under one temp dir.
const TEST_HOME = mkdtempSync("/var/tmp/tc2096.");
const PREVIOUS_ENV = { HOME: process.env.HOME, BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR };
process.env.HOME = TEST_HOME;
process.env.BUN_INSTALL_CACHE_DIR = TEST_HOME;
if (!process.env.HOME.startsWith("/var/tmp/tc2096.")) throw new Error("test home is not a temp dir");

import { FakeNode, newStore } from "../test/fixtures.js";
import { Replica } from "./engine.js";

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  for (const [name, value] of Object.entries(PREVIOUS_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const freshStore = () => {
  expect(process.env.HOME).toBe(TEST_HOME);
  return newStore(mkdtempSync(`${TEST_HOME}/store.`));
};

function nodeWith(count: number): FakeNode {
  const node = new FakeNode();
  for (let i = 0; i < count; i += 1) node.put(`notes/k${i}`, `value ${i}`);
  return node;
}

describe("contentFetch", () => {
  test("lazy commits every entry with zero fetchContent calls and reads report content_missing", async () => {
    const node = nodeWith(7);
    const store = await freshStore();
    const replica = new Replica({ store, transport: node, contentFetch: "lazy" });

    const report = await replica.sync({ limit: 3 });
    expect(node.fetchCalls).toBe(0);
    expect(report).toMatchObject({ changes: 7, fetched: 0, repaired: 0, contentMissing: 7, coverage: "complete" });
    expect((await replica.list()).entries).toHaveLength(7);
    expect((await replica.get("notes/k3")).status).toBe("content_missing");
  });

  test("a lazily skipped entry is never repaired, in this or a later session", async () => {
    const node = nodeWith(3);
    const store = await freshStore();
    const lazy = new Replica({ store, transport: node, contentFetch: "lazy" });
    await lazy.sync();
    for (let i = 0; i < 3; i += 1) await lazy.sync();
    // A new Replica is a new session: still nothing downloads in the background.
    const later = new Replica({ store, transport: node, contentFetch: "lazy" });
    const report = await later.sync();
    expect(report).toMatchObject({ repaired: 0, contentMissing: 3 });
    expect(node.fetchCalls).toBe(0);
  });

  test("lazy keeps values already held and skips only the ones it does not hold", async () => {
    const node = nodeWith(2);
    const store = await freshStore();
    await new Replica({ store, transport: node }).sync();
    expect(node.fetchCalls).toBe(1);

    node.put("notes/new", "fresh");
    const lazy = new Replica({ store, transport: node, contentFetch: "lazy" });
    const report = await lazy.sync();
    expect(node.fetchCalls).toBe(1);
    expect(report).toMatchObject({ changes: 1, fetched: 0, contentMissing: 1 });
    const held = await lazy.get("notes/k0");
    expect(held.status === "present" && text(held.value)).toBe("value 0");
    expect((await lazy.get("notes/new")).status).toBe("content_missing");
  });

  test("eager, by default and when named, downloads each value", async () => {
    for (const options of [{}, { contentFetch: "eager" as const }]) {
      const node = nodeWith(4);
      const store = await freshStore();
      const replica = new Replica({ store, transport: node, ...options });
      const report = await replica.sync();
      expect(node.fetchCalls).toBe(1);
      expect(report).toMatchObject({ changes: 4, fetched: 4, contentMissing: 0 });
      const value = await replica.get("notes/k2");
      expect(value.status === "present" && text(value.value)).toBe("value 2");
    }
  });
});
