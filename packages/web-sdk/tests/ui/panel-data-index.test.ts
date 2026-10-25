import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelDataHost } from "../../src/ui/data";
import { createRealPanelData } from "../../src/ui/data/real";
import type { PanelClient } from "../../src/ui/slots";

const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
let now = 0;
let timers: Array<{ run: () => void; ms: number }> = [];

beforeEach(() => {
  now = Date.UTC(2025, 0, 1);
  Date.now = () => now;
  timers = [];
  globalThis.setTimeout = ((run: () => void, ms?: number) => {
    timers.push({ run, ms: ms ?? 0 });
    return 0;
  }) as unknown as typeof setTimeout;
});

afterEach(() => {
  Date.now = realNow;
  globalThis.setTimeout = realSetTimeout;
});

type IndexResult =
  | { ok: true; data: unknown[] }
  | { ok: false; error: { code: string; message?: string; service: string } };

const missing = (table: string): IndexResult => ({
  ok: false,
  error: { code: "SQL_ERROR", message: `SQL query failed: 400 - SQLite error: no such table: ${table}`, service: "sql" },
});
const failed = (code: string, message?: string): IndexResult => ({
  ok: false,
  error: { code, ...(message !== undefined ? { message } : {}), service: "sql" },
});
const rows = (n: number): IndexResult => ({ ok: true, data: Array.from({ length: n }, (_, i) => ({ i })) });

function makeFakes() {
  const state = { spaces: rows(0) as IndexResult, applications: rows(0) as IndexResult, reads: 0 };
  let resetCb: (() => void) | undefined;
  const host = {
    did: "did:key:account",
    sessionDid: "did:key:session",
    hosts: ["https://node.example"],
    account: {
      index: {
        spaces: {
          list: async () => {
            state.reads += 1;
            return state.spaces;
          },
        },
        applications: { list: async () => state.applications },
      },
    },
    delegations: {
      query: async () => ({ ok: true, data: { schemaVersion: 2, items: [] } }),
      status: async () => ({ ok: true, data: { status: "active" } }),
      revoke: async () => ({ ok: true, data: { revoked: true } }),
    },
    storage: { status: async () => ({ ok: true, data: { state: "ready" } }) },
    activeNodeIdentity: async () => undefined,
  } as unknown as PanelDataHost;
  const client = {
    onReset(cb: () => void) {
      resetCb = cb;
      return () => {};
    },
  } as unknown as PanelClient;
  return { host, client, state, reset: () => resetCb?.() };
}

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

describe("account index not created yet", () => {
  test("a missing spaces table is an empty list: the view is ready and the count is unknown, not 0", async () => {
    const f = makeFakes();
    f.state.spaces = missing("spaces");
    f.state.applications = rows(2);
    const view = await createRealPanelData(f.host, f.client, "Notes").account();
    expect(view.state).toBe("ready");
    if (view.state !== "ready") return;
    expect(view.data.did).toBe("did:key:account");
    expect(view.data.appName).toBe("Notes");
    expect("spaces" in view.data).toBe(false);
    expect(view.data.applications).toBe(2);
  });

  test("a missing applications table is an empty list too", async () => {
    const f = makeFakes();
    f.state.spaces = rows(3);
    f.state.applications = missing("applications");
    const view = await createRealPanelData(f.host, f.client, "Notes").account();
    expect(view.state).toBe("ready");
    if (view.state !== "ready") return;
    expect("applications" in view.data).toBe(false);
    expect(view.data.spaces).toBe(3);
  });

  test("both tables missing: ready, both counts unknown", async () => {
    const f = makeFakes();
    f.state.spaces = missing("spaces");
    f.state.applications = missing("applications");
    const view = await createRealPanelData(f.host, f.client, "Notes").account();
    expect(view.state).toBe("ready");
    if (view.state !== "ready") return;
    expect("spaces" in view.data).toBe(false);
    expect("applications" in view.data).toBe(false);
  });

  test("the message decides, case-insensitively, whatever the code", async () => {
    for (const [code, message] of [
      ["SQL_ERROR", "SQLite error: No Such Table: spaces"],
      ["NETWORK_ERROR", "no such table: applications"],
      ["ANYTHING", "SQL query failed: 400 - SQLite error: NO SUCH TABLE: x"],
    ] as const) {
      const f = makeFakes();
      f.state.spaces = failed(code, message);
      const view = await createRealPanelData(f.host, f.client, "Notes").account();
      expect(view.state).toBe("ready");
    }
  });
  test("any other failure stays an error with its code, on either read", async () => {
    const cases = [
      { code: "SQL_ERROR", result: failed("SQL_ERROR", "SQLite error: no such column: x") },
      { code: "SQL_ERROR", result: failed("SQL_ERROR") },
      { code: "NETWORK_ERROR", result: failed("NETWORK_ERROR", "Failed to fetch") },
      { code: "PERMISSION_DENIED", result: failed("PERMISSION_DENIED", "denied") },
    ];
    for (const { code, result } of cases) {
      for (const which of ["spaces", "applications"] as const) {
        const f = makeFakes();
        f.state[which] = result;
        const view = await createRealPanelData(f.host, f.client, "Notes").account();
        expect(view).toEqual({ state: "error", code });
      }
    }
  });

  test("once the index exists the next read reports the counts", async () => {
    const f = makeFakes();
    f.state.spaces = missing("spaces");
    f.state.applications = missing("applications");
    const data = createRealPanelData(f.host, f.client, "Notes");
    await data.account();

    f.state.spaces = rows(2);
    f.state.applications = rows(1);
    now += 60_001;
    await data.account();
    await settle();
    const view = await data.account();
    expect(view.state === "ready" && [view.data.spaces, view.data.applications]).toEqual([2, 1]);
  });
});

describe("account read that failed", () => {
  test("one retry is scheduled, it reads again, and a ready result clears it", async () => {
    const f = makeFakes();
    f.state.spaces = failed("NETWORK_ERROR", "Failed to fetch");
    const data = createRealPanelData(f.host, f.client, "Notes");
    const seen: string[] = [];
    data.subscribe((view) => seen.push(view));
    expect((await data.account()).state).toBe("error");
    expect(timers.map((t) => t.ms)).toEqual([5_000]);
    expect(f.state.reads).toBe(1);

    f.state.spaces = rows(1);
    timers[0]?.run();
    await settle();
    expect(f.state.reads).toBe(2);
    expect((await data.account()).state).toBe("ready");
    // The panel is told when the retry starts and when it settles.
    expect(seen.filter((v) => v === "overview").length).toBeGreaterThanOrEqual(4);
    expect(timers).toHaveLength(1);
  });

  test("a retry that fails again is not followed by another", async () => {
    const f = makeFakes();
    f.state.spaces = failed("NETWORK_ERROR", "Failed to fetch");
    const data = createRealPanelData(f.host, f.client, "Notes");
    await data.account();
    timers[0]?.run();
    await settle();
    expect(f.state.reads).toBe(2);
    expect(timers).toHaveLength(1);
    expect((await data.account()).state).toBe("error");
  });

  test("a reset before the retry fires drops it", async () => {
    const f = makeFakes();
    f.state.spaces = failed("NETWORK_ERROR", "Failed to fetch");
    const data = createRealPanelData(f.host, f.client, "Notes");
    await data.account();
    f.reset();
    timers[0]?.run();
    await settle();
    expect(f.state.reads).toBe(1);
  });

  test("a missing index is a ready view, so nothing is retried", async () => {
    const f = makeFakes();
    f.state.spaces = missing("spaces");
    await createRealPanelData(f.host, f.client, "Notes").account();
    expect(timers).toHaveLength(0);
  });
});

describe("known DID", () => {
  test("is the account's DID without a read, and gone after a reset", () => {
    const f = makeFakes();
    const data = createRealPanelData(f.host, f.client, "Notes");
    expect(data.knownDid?.()).toBe("did:key:account");
    expect(f.state.reads).toBe(0);
    f.reset();
    expect(data.knownDid?.()).toBeUndefined();
  });
});
