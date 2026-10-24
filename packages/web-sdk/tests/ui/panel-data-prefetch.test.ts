import { describe, expect, test } from "bun:test";

import type { PanelDataSource } from "../../src/ui/data";
import { createPanelPrefetch, type PrefetchDeps } from "../../src/ui/data/prefetch";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(err: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function fakeData(failing: "account" | "delegations" | "storage" | null = null) {
  const calls = { account: 0, delegations: 0, storage: 0 };
  const read = (name: "account" | "delegations" | "storage") => async () => {
    calls[name] += 1;
    if (failing === name) throw new Error(`${name} failed`);
    return { ok: true };
  };
  const data = {
    account: read("account"),
    delegations: read("delegations"),
    storage: read("storage"),
  } as unknown as PanelDataSource;
  return { data, calls };
}

function harness(overrides: Partial<PrefetchDeps> & { data?: PanelDataSource } = {}) {
  const idle = deferred();
  const settled = deferred();
  const resets: Array<() => void> = [];
  const { data, calls } = fakeData();
  const deps: PrefetchDeps = {
    data: overrides.data ?? data,
    idle: overrides.idle ?? (() => idle.promise),
    registrySettled: overrides.registrySettled ?? (() => settled.promise),
    onReset: overrides.onReset ?? ((cb) => {
      resets.push(cb);
      return () => {
        resets.splice(resets.indexOf(cb), 1);
      };
    }),
  };
  const prefetch = createPanelPrefetch(deps);
  return {
    prefetch,
    calls,
    idle,
    settled,
    reset: () => resets.forEach((cb) => cb()),
  };
}

describe("panel prefetch gate", () => {
  test("waits for idle and registry settle before reading", async () => {
    const h = harness();
    h.idle.resolve();
    await flush();
    expect(h.calls).toEqual({ account: 0, delegations: 0, storage: 0 });

    h.settled.resolve();
    await flush();
    expect(h.calls).toEqual({ account: 1, delegations: 1, storage: 1 });
  });

  test("registry settle alone does not start the pull before idle", async () => {
    const h = harness();
    h.settled.resolve();
    await flush();
    expect(h.calls.account).toBe(0);
  });

  test("a rejected gate still starts the pull", async () => {
    const h = harness({ registrySettled: () => Promise.reject(new Error("sync failed")) });
    h.idle.resolve();
    await flush();
    expect(h.calls).toEqual({ account: 1, delegations: 1, storage: 1 });
  });
});

describe("panel prefetch intent", () => {
  test("an intent starts the pull without waiting for idle or registry settle", async () => {
    const h = harness();
    h.prefetch.intent();
    await flush();
    expect(h.calls).toEqual({ account: 1, delegations: 1, storage: 1 });
  });

  test("starts at most once across intents and the gate", async () => {
    const h = harness();
    h.prefetch.intent();
    h.prefetch.intent();
    h.idle.resolve();
    h.settled.resolve();
    await flush();
    expect(h.calls).toEqual({ account: 1, delegations: 1, storage: 1 });
  });
});

describe("panel prefetch reset", () => {
  test("reset before the gate opens cancels the pull", async () => {
    const h = harness();
    h.reset();
    h.idle.resolve();
    h.settled.resolve();
    await flush();
    expect(h.calls).toEqual({ account: 0, delegations: 0, storage: 0 });
  });

  test("an intent after reset does not start the pull", async () => {
    const h = harness();
    h.reset();
    h.prefetch.intent();
    await flush();
    expect(h.calls.account).toBe(0);
  });
});

describe("panel prefetch failures", () => {
  test("a failing read does not stop the other reads", async () => {
    const { data, calls } = fakeData("account");
    const h = harness({ data });
    h.prefetch.intent();
    await flush();
    expect(calls).toEqual({ account: 1, delegations: 1, storage: 1 });
  });
});
