import { afterEach, describe, expect, test } from "bun:test";

import type { PanelDataSource } from "../../src/ui/data";
import { browserIdle } from "../../src/ui/data/prefetch";
import { armPanelPrefetch, intentPanelPrefetch } from "../../src/ui/panel-data-entry";
import type { PanelClient } from "../../src/ui/slots";

function fakeClient(signedIn: boolean) {
  const reads = { account: 0, delegations: 0, storage: 0 };
  const resets: Array<() => void> = [];
  const data = {
    account: async () => (reads.account += 1, { ok: true }),
    delegations: async () => (reads.delegations += 1, { ok: true }),
    storage: async () => (reads.storage += 1, { ok: true }),
  } as unknown as PanelDataSource;
  const client = {
    data,
    signedIn: () => signedIn,
    onReset: (cb: () => void) => {
      resets.push(cb);
      return () => {
        resets.splice(resets.indexOf(cb), 1);
      };
    },
  } as unknown as PanelClient;
  return {
    client,
    reads,
    reset: () => resets.slice().forEach((cb) => cb()),
  };
}

const settled = async (): Promise<void> => {};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("panel prefetch arming", () => {
  test("does nothing when armed while signed out", async () => {
    const { client, reads } = fakeClient(false);
    armPanelPrefetch(client, settled);
    intentPanelPrefetch(client);
    await flush();
    expect(reads).toEqual({ account: 0, delegations: 0, storage: 0 });
  });

  test("an intent after arming on sign-in reads all three sections once", async () => {
    const { client, reads } = fakeClient(true);
    armPanelPrefetch(client, settled);
    intentPanelPrefetch(client);
    intentPanelPrefetch(client);
    await flush();
    expect(reads).toEqual({ account: 1, delegations: 1, storage: 1 });
  });

  test("a reset disarms the pull, so a later intent reads nothing", async () => {
    const { client, reads, reset } = fakeClient(true);
    armPanelPrefetch(client, settled);
    reset();
    intentPanelPrefetch(client);
    await flush();
    expect(reads).toEqual({ account: 0, delegations: 0, storage: 0 });
  });

  test("arming again after a reset starts a new pull on the next intent", async () => {
    const { client, reads, reset } = fakeClient(true);
    armPanelPrefetch(client, settled);
    reset();
    armPanelPrefetch(client, settled);
    intentPanelPrefetch(client);
    await flush();
    expect(reads).toEqual({ account: 1, delegations: 1, storage: 1 });
  });

  test("an intent without a client is a no-op", () => {
    expect(() => intentPanelPrefetch(undefined)).not.toThrow();
  });
});

// Bun has no requestIdleCallback. The idle tests install and remove one, so the global is typed by name here.
interface IdleGlobal {
  requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => number;
}
const idleGlobal: IdleGlobal = globalThis;

describe("browser idle gate", () => {
  const original = idleGlobal.requestIdleCallback;

  afterEach(() => {
    // `in` checks in browserIdle see any own property, so an absent original must be deleted, not set to undefined.
    if (original === undefined) delete idleGlobal.requestIdleCallback;
    else idleGlobal.requestIdleCallback = original;
  });

  test("resolves when requestIdleCallback fires, with a 3 s cap", async () => {
    let timeoutOption: number | undefined;
    let fire: () => void = () => {};
    idleGlobal.requestIdleCallback = (cb, opts) => {
      timeoutOption = opts.timeout;
      fire = cb;
      return 1;
    };
    let done = false;
    const idle = browserIdle().then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    expect(timeoutOption).toBe(3000);
    fire();
    await idle;
    expect(done).toBe(true);
  });

  test("falls back to a 2 s timer where requestIdleCallback is missing", async () => {
    delete idleGlobal.requestIdleCallback;
    const started = Date.now();
    await browserIdle();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  }, 5000);
});
