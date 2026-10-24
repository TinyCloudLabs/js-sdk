import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelDataHost, PanelView } from "../../src/ui/data";
import { createRealPanelData } from "../../src/ui/data/real";
import type { PanelClient } from "../../src/ui/slots";

// Reset (sign-out or account switch) while a read is in flight. The old read
// must not write, notify, or return what it fetched for the previous account.

const SESSION = "did:key:session";
const NODE = "https://node.example";
const realNow = Date.now;
let now = 0;

beforeEach(() => {
  now = Date.UTC(2025, 0, 1);
  Date.now = () => now;
});

afterEach(() => {
  Date.now = realNow;
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function delegation(cid: string) {
  return {
    cid,
    direction: "granted",
    status: "active",
    delegatorDid: SESSION,
    delegateDid: "did:key:other",
    resources: [{ resource: "tinycloud:x", actions: ["read"] }],
    parents: [],
    issuedAt: new Date(now),
    notBefore: new Date(now),
    expiresAt: null,
  };
}

function page(items: unknown[], nextCursor?: string) {
  return { ok: true, data: { schemaVersion: 2, items, ...(nextCursor ? { nextCursor } : {}) } };
}

function fakeHost() {
  const queues = {
    query: [] as Deferred<unknown>[],
    status: [] as Deferred<unknown>[],
    storage: [] as Deferred<unknown>[],
    identity: [] as Deferred<unknown>[],
  };
  const defaults = {
    query: page([]) as unknown,
    status: { ok: true, data: { status: "active" } } as unknown,
    storage: { ok: true, data: { state: "ready" } } as unknown,
    identity: undefined as unknown,
  };
  const calls = { query: 0, revoke: [] as string[] };
  const answer = (queue: Deferred<unknown>[], fallback: unknown): Promise<unknown> =>
    queue.shift()?.promise ?? Promise.resolve(fallback);

  const host = {
    did: "did:key:account",
    sessionDid: SESSION,
    hosts: [NODE],
    account: {
      index: {
        spaces: { list: async () => ({ ok: true, data: [] }) },
        applications: { list: async () => ({ ok: true, data: [] }) },
      },
    },
    delegations: {
      query: async () => {
        calls.query += 1;
        return answer(queues.query, defaults.query);
      },
      status: async () => answer(queues.status, defaults.status),
      revoke: async (cid: string) => {
        calls.revoke.push(cid);
        return { ok: true, data: { revoked: true, cid } };
      },
    },
    storage: {
      status: async () => answer(queues.storage, defaults.storage),
    },
    activeNodeIdentity: async () => answer(queues.identity, defaults.identity),
  } as unknown as PanelDataHost;

  return { host, queues, defaults, calls };
}

function fakeClient() {
  const callbacks: Array<() => void> = [];
  const client = {
    onReset(cb: () => void) {
      callbacks.push(cb);
      return () => {};
    },
  } as unknown as PanelClient;
  return {
    client,
    reset() {
      for (const cb of callbacks) cb();
    },
  };
}

describe("real adapter: reset while a read is in flight", () => {
  test("a background refresh that resolves after reset emits nothing", async () => {
    const h = fakeHost();
    const c = fakeClient();
    const data = createRealPanelData(h.host, c.client, "app");
    await data.delegations();

    const seen: PanelView[] = [];
    data.subscribe((view) => seen.push(view));
    now += 10_001; // past the TTL: the next read refreshes in the background
    const held = deferred<unknown>();
    h.queues.query.push(held);
    void data.delegations();

    c.reset();
    const emittedBeforeResolve = seen.length;
    held.resolve(page([delegation("c-old")]));
    await flush();

    expect(seen.length).toBe(emittedBeforeResolve);
  });

  test("a first read that resolves after reset returns loading, not the old account's rows", async () => {
    const h = fakeHost();
    const c = fakeClient();
    const data = createRealPanelData(h.host, c.client, "app");

    const held = deferred<unknown>();
    h.queues.query.push(held);
    const pending = data.delegations();
    c.reset();
    held.resolve(page([delegation("c-old")]));

    const view = await pending;
    expect(view.state).toBe("loading");
  });

  test("a forced read that resolves after reset does not return the previous account's value", async () => {
    const h = fakeHost();
    h.defaults.storage = { ok: true, data: { state: "ready", usedBytes: 1 } };
    const c = fakeClient();
    const data = createRealPanelData(h.host, c.client, "app");
    expect((await data.storage()).state).toBe("ready");

    const held = deferred<unknown>();
    h.queues.storage.push(held);
    const pending = data.storage({ fresh: true });
    c.reset();
    held.resolve({ ok: true, data: { state: "ready", usedBytes: 999 } });

    const view = await pending;
    expect(view.state).toBe("loading");
  });
});

describe("real adapter: delegation cursors across account reset", () => {
  test("a cursor from before reset is refused without querying", async () => {
    const h = fakeHost();
    h.defaults.query = page([delegation("c1")], "cur-A");
    const c = fakeClient();
    const data = createRealPanelData(h.host, c.client, "app");
    expect((await data.delegations()).state).toBe("ready");

    c.reset();
    const view = await data.delegations("cur-A");

    expect(view.state).not.toBe("ready");
    expect(h.calls.query).toBe(1);
  });

  test("a cursor page that resolves after reset is dropped, not returned", async () => {
    const h = fakeHost();
    h.defaults.query = page([delegation("c1")], "cur-A");
    const c = fakeClient();
    const data = createRealPanelData(h.host, c.client, "app");
    await data.delegations();

    const held = deferred<unknown>();
    h.queues.query.push(held);
    const pending = data.delegations("cur-A");
    c.reset();
    held.resolve(page([delegation("c-old-2")]));

    const view = await pending;
    expect(view.state).not.toBe("ready");
  });

  test("a cursor issued after reset is accepted", async () => {
    const h = fakeHost();
    h.defaults.query = page([delegation("c1")], "cur-A");
    const c = fakeClient();
    const data = createRealPanelData(h.host, c.client, "app");
    await data.delegations();

    c.reset();
    h.defaults.query = page([delegation("c2")], "cur-B");
    expect((await data.delegations()).state).toBe("ready");
    expect((await data.delegations("cur-B")).state).toBe("ready");
  });
});

describe("real adapter: account reset while identity or revoke reads are in flight", () => {
  test("a revoke whose status check resolves after reset is not sent", async () => {
    const h = fakeHost();
    const c = fakeClient();
    const data = createRealPanelData(h.host, c.client, "app");

    const held = deferred<unknown>();
    h.queues.status.push(held);
    const pending = data.revoke("c1");
    c.reset();
    held.resolve({ ok: true, data: { status: "active" } });

    const outcome = await pending;
    expect(h.calls.revoke).toEqual([]);
    expect(outcome.ok).toBe(false);
  });

  test("nodes() resolving after reset does not mark the previous account's node active", async () => {
    const h = fakeHost();
    const c = fakeClient();
    const data = createRealPanelData(h.host, c.client, "app");

    const held = deferred<unknown>();
    h.queues.identity.push(held);
    const pending = data.nodes();
    c.reset();
    held.resolve({ origin: NODE, nodeDid: "did:key:node-old" });

    const view = await pending;
    expect(view.state).toBe("loading");
  });

  test("localNode() resolving after reset does not return the previous identity", async () => {
    const h = fakeHost();
    const c = fakeClient();
    const data = createRealPanelData(h.host, c.client, "app");

    const held = deferred<unknown>();
    h.queues.identity.push(held);
    const pending = data.localNode();
    c.reset();
    held.resolve({ origin: NODE, nodeDid: "did:key:node-old" });

    const view = await pending;
    expect(view.state).toBe("loading");
  });
});
