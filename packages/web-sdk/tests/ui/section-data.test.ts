import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import type { PanelDataSource, ViewResult } from "../../src/ui/data";
import { createSectionData } from "../../src/ui/section-data";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const ok = <T>(data: T): ViewResult<T> => ({ state: "ready", data }) as ViewResult<T>;

interface FakeSource {
  readonly source: PanelDataSource;
  readonly calls: string[];
  fire(): void;
  results: Record<string, () => Promise<ViewResult<unknown>>>;
}

function fakeSource(): FakeSource {
  const calls: string[] = [];
  let listener: (() => void) | undefined;
  const fake: FakeSource = {
    calls,
    results: {},
    fire: () => listener?.(),
    source: undefined as unknown as PanelDataSource,
  };
  const read = (key: string) => async () => {
    calls.push(key);
    return (fake.results[key] ?? (async () => ok(key)))();
  };
  (fake as { source: PanelDataSource }).source = {
    subscribe: (cb: () => void) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    },
    localNode: read("localNode"),
    localCopy: read("localCopy"),
    delegations: read("delegations"),
    nodes: read("nodes"),
    storage: read("storage"),
  } as unknown as PanelDataSource;
  return fake;
}

describe("section data cache", () => {
  test("latest is undefined before the first read and the read result after", async () => {
    const fake = fakeSource();
    const data = createSectionData(() => fake.source);
    expect(data.latest("nodes")).toBeUndefined();
    await data.refresh("nodes");
    expect(data.latest("nodes")).toEqual(ok("nodes"));
  });

  test("start reads every view once, then follows source changes", async () => {
    const fake = fakeSource();
    const data = createSectionData(() => fake.source);
    data.start();
    await flush();
    expect(fake.calls.sort()).toEqual(["delegations", "localCopy", "localNode", "nodes", "storage"]);
    fake.calls.length = 0;
    fake.fire();
    await flush();
    expect(fake.calls.length).toBe(5);
    data.stop();
  });

  test("start twice reads once", async () => {
    const fake = fakeSource();
    const data = createSectionData(() => fake.source);
    data.start();
    data.start();
    await flush();
    expect(fake.calls.length).toBe(5);
    data.stop();
  });

  test("a minute tick re-reads while started, and stop ends the ticks and the subscription", async () => {
    const fake = fakeSource();
    const data = createSectionData(() => fake.source);
    data.start();
    await flush();
    fake.calls.length = 0;
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(fake.calls.length).toBe(5);
    data.stop();
    fake.calls.length = 0;
    jest.advanceTimersByTime(180_000);
    fake.fire();
    await flush();
    expect(fake.calls).toEqual([]);
  });

  test("a rejected read is cached as an error result", async () => {
    const fake = fakeSource();
    fake.results.nodes = async () => {
      throw new Error("boom");
    };
    const data = createSectionData(() => fake.source);
    await data.refresh("nodes");
    expect(data.latest("nodes")).toEqual({ state: "error", code: "unknown" });
  });

  test("a read that settles after reset is dropped", async () => {
    const fake = fakeSource();
    let release: (value: ViewResult<unknown>) => void = () => undefined;
    fake.results.storage = () => new Promise((resolve) => (release = resolve));
    const data = createSectionData(() => fake.source);
    const pending = data.refresh("storage");
    data.reset();
    release(ok("old account"));
    await pending;
    expect(data.latest("storage")).toBeUndefined();
  });

  test("a read in flight across a reset writes nothing and notifies no one", async () => {
    const fake = fakeSource();
    let release: (value: ViewResult<unknown>) => void = () => undefined;
    fake.results.delegations = () => new Promise((resolve) => (release = resolve));
    const data = createSectionData(() => fake.source);
    let heard = 0;
    data.subscribe(() => {
      heard += 1;
    });
    const pending = data.refresh("delegations");
    data.reset();
    heard = 0; // reset itself tells subscribers once
    release(ok("the old account's page"));
    await pending;
    expect(data.latest("delegations")).toBeUndefined();
    expect(heard).toBe(0);
  });

  test("generation changes on reset only; stop and start keep it", async () => {
    const fake = fakeSource();
    const data = createSectionData(() => fake.source);
    const first = data.generation();
    data.start();
    await flush();
    data.stop();
    data.start();
    await flush();
    expect(data.generation()).toBe(first);
    data.reset();
    expect(data.generation()).toBe(first + 1);
    data.stop();
  });

  test("a read in flight across stop is dropped too, without changing the generation", async () => {
    const fake = fakeSource();
    let release: (value: ViewResult<unknown>) => void = () => undefined;
    fake.results.nodes = () => new Promise((resolve) => (release = resolve));
    const data = createSectionData(() => fake.source);
    const pending = data.refresh("nodes");
    data.stop();
    release(ok("late"));
    await pending;
    expect(data.latest("nodes")).toBeUndefined();
  });

  test("reset clears results and tells subscribers", async () => {
    const fake = fakeSource();
    const data = createSectionData(() => fake.source);
    await data.refresh("nodes");
    let heard = 0;
    data.subscribe(() => {
      heard += 1;
    });
    data.reset();
    expect(data.latest("nodes")).toBeUndefined();
    expect(heard).toBe(1);
  });

  test("age counts up from when the result settled", async () => {
    const fake = fakeSource();
    let clock = 1000;
    const data = createSectionData(() => fake.source, () => clock);
    expect(data.age("nodes")).toBeUndefined();
    await data.refresh("nodes");
    clock += 250;
    expect(data.age("nodes")).toBe(250);
  });

  test("with no source nothing is read and the cache stays empty", async () => {
    const data = createSectionData(() => undefined);
    await data.refresh();
    expect(data.latest("nodes")).toBeUndefined();
    expect(data.source).toBeUndefined();
  });

  test("subscribe's unsubscribe stops notifications; notify reaches the rest", async () => {
    const data = createSectionData(() => undefined);
    let a = 0;
    let b = 0;
    const offA = data.subscribe(() => {
      a += 1;
    });
    data.subscribe(() => {
      b += 1;
    });
    offA();
    data.notify();
    expect([a, b]).toEqual([0, 1]);
  });
});
