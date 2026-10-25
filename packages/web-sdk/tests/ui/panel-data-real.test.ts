import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelDataHost } from "../../src/ui/data";
import { createRealPanelData } from "../../src/ui/data/real";
import type { PanelClient } from "../../src/ui/slots";

const SESSION = "did:key:session";
const realNow = Date.now;
let now = 0;

beforeEach(() => {
  now = Date.UTC(2025, 0, 1);
  Date.now = () => now;
});

afterEach(() => {
  Date.now = realNow;
});

function delegation(cid: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

interface Fakes {
  host: PanelDataHost;
  client: PanelClient & { reset(): void };
  calls: { query: number; revoke: string[]; storage: number };
  setQuery(next: unknown): void;
  setStatus(next: unknown): void;
  setStorage(next: unknown): void;
  setRevoke(next: unknown): void;
}

function makeFakes(): Fakes {
  const calls = { query: 0, revoke: [] as string[], storage: 0 };
  let queryResult: unknown = { ok: true, data: { schemaVersion: 2, items: [] } };
  let statusResult: unknown = { ok: true, data: { status: "active" } };
  let storageResult: unknown = { ok: true, data: { state: "ready" } };
  let revokeResult: unknown;
  let resetCb: (() => void) | undefined;

  const host = {
    did: "did:key:account",
    sessionDid: SESSION,
    hosts: ["https://node.example"],
    account: {
      index: {
        spaces: { list: async () => ({ ok: true, data: [] }) },
        applications: { list: async () => ({ ok: true, data: [] }) },
      },
    },
    delegations: {
      query: async () => {
        calls.query += 1;
        return queryResult;
      },
      status: async () => statusResult,
      revoke: async (cid: string) => {
        calls.revoke.push(cid);
        return revokeResult ?? { ok: true, data: { revoked: true, cid } };
      },
    },
    storage: {
      status: async () => {
        calls.storage += 1;
        return storageResult;
      },
    },
    activeNodeIdentity: async () => undefined,
  } as unknown as PanelDataHost;

  const client = {
    onReset(cb: () => void) {
      resetCb = cb;
      return () => {};
    },
    reset() {
      resetCb?.();
    },
  } as unknown as PanelClient & { reset(): void };

  return {
    host,
    client,
    calls,
    setQuery: (next) => {
      queryResult = next;
    },
    setStatus: (next) => {
      statusResult = next;
    },
    setRevoke: (next) => {
      revokeResult = next;
    },
    setStorage: (next) => {
      storageResult = next;
    },
  };
}

describe("createRealPanelData delegations", () => {
  test("first read maps rows with group, derived label and expiring flag", async () => {
    const f = makeFakes();
    f.setQuery({
      ok: true,
      data: {
        schemaVersion: 2,
        items: [
          delegation("c1", { expiresAt: new Date(now + 60_000) }),
          delegation("c2", { direction: "received", delegateDid: SESSION }),
        ],
      },
    });
    const data = createRealPanelData(f.host, f.client, "app");

    const view = await data.delegations();
    expect(view.state).toBe("ready");
    if (view.state !== "ready") return;
    const [first, second] = view.data.rows;
    expect(first?.group).toBe("to-others");
    expect(first?.expiringSoon).toBe(true);
    expect(first?.label.source).toBe("derived");
    expect(second?.group).toBe("received");
  });

  test("fresh snapshot is served without refetching; stale snapshot refetches in background", async () => {
    const f = makeFakes();
    const data = createRealPanelData(f.host, f.client, "app");

    await data.delegations();
    expect(f.calls.query).toBe(1);

    await data.delegations();
    expect(f.calls.query).toBe(1);

    now += 10_001;
    const stale = await data.delegations();
    expect(stale.state).toBe("ready");
    expect(f.calls.query).toBe(2);
  });

  test("a failed refresh keeps the previous ready snapshot", async () => {
    const f = makeFakes();
    const data = createRealPanelData(f.host, f.client, "app");
    await data.delegations();

    f.setQuery({ ok: false, error: { code: "NETWORK", message: "down", service: "delegation" } });
    now += 10_001;
    await data.delegations();
    expect(f.calls.query).toBe(2);
    // Let the background refresh settle. Microtasks only, no wall clock.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    const after = await data.delegations();
    expect(after.state).toBe("ready");
  });

  test("ready results carry freshness; a stale read reports refreshing until it settles", async () => {
    const f = makeFakes();
    const data = createRealPanelData(f.host, f.client, "app");
    await data.delegations();

    now += 10_001;
    const during = await data.delegations();
    expect(during.state === "ready" && during.freshness?.refreshing).toBe(true);

    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    const settled = await data.delegations();
    expect(settled.state === "ready" && settled.freshness).toEqual({
      updatedAt: now,
      refreshing: false,
      lastError: undefined,
    });
  });

  test("a failed refresh keeps the old updatedAt and records lastError", async () => {
    const f = makeFakes();
    const data = createRealPanelData(f.host, f.client, "app");
    const first = Date.now();
    await data.delegations();

    f.setQuery({ ok: false, error: { code: "NETWORK", message: "down", service: "delegation" } });
    now += 10_001;
    await data.delegations();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    const after = await data.delegations();
    expect(after.state === "ready" && after.freshness?.lastError).toBe("NETWORK");
    expect(after.state === "ready" && after.freshness?.updatedAt).toBe(first);
  });

  test("a failed refresh is not retried on every read; the next attempt waits for the TTL", async () => {
    const f = makeFakes();
    const data = createRealPanelData(f.host, f.client, "app");
    await data.delegations();

    f.setQuery({ ok: false, error: { code: "NETWORK", message: "down", service: "delegation" } });
    now += 10_001;
    await data.delegations();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(f.calls.query).toBe(2);

    // Re-renders read again inside the TTL: no new network call.
    await data.delegations();
    await data.delegations();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(f.calls.query).toBe(2);

    now += 10_001;
    await data.delegations();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(f.calls.query).toBe(3);
  });

  test("denied list maps to needs-permission for delegation/list", async () => {
    const f = makeFakes();
    f.setQuery({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "no", service: "delegation" },
    });
    const data = createRealPanelData(f.host, f.client, "app");

    const view = await data.delegations();
    expect(view.state).toBe("needs-permission");
  });

  test("reset discards snapshots so the next read refetches", async () => {
    const f = makeFakes();
    const data = createRealPanelData(f.host, f.client, "app");
    await data.delegations();
    expect(f.calls.query).toBe(1);

    f.client.reset();
    await data.delegations();
    expect(f.calls.query).toBe(2);
  });
});

describe("createRealPanelData revoke", () => {
  test("refuses a delegation whose status is not active, without calling revoke", async () => {
    const f = makeFakes();
    f.setStatus({ ok: true, data: { status: "revoked" } });
    const data = createRealPanelData(f.host, f.client, "app");

    const outcome = await data.revoke("c1");
    expect(outcome).toEqual({ ok: false, code: "not-revocable" });
    expect(f.calls.revoke).toEqual([]);
  });

  test("revokes an active delegation and refetches the list", async () => {
    const f = makeFakes();
    const data = createRealPanelData(f.host, f.client, "app");
    await data.delegations();
    expect(f.calls.query).toBe(1);

    const outcome = await data.revoke("c1");
    expect(outcome).toEqual({ ok: true, cid: "c1" });
    expect(f.calls.revoke).toEqual(["c1"]);
    expect(f.calls.query).toBe(2);
  });

  test("a status that cannot be read (NOT_FOUND) does not stop the revoke: the node decides, then the list is refetched", async () => {
    const f = makeFakes();
    f.setStatus({ ok: false, error: { code: "NOT_FOUND", message: "no", service: "delegation" } });
    const data = createRealPanelData(f.host, f.client, "app");
    await data.delegations();

    expect(await data.revoke("c1")).toEqual({ ok: true, cid: "c1" });
    expect(f.calls.revoke).toEqual(["c1"]);
    expect(f.calls.query).toBe(2);
  });

  test("a status that is not an explicit revoked answer (expired, unavailable) still attempts the revoke", async () => {
    for (const status of ["expired", "unavailable"]) {
      const f = makeFakes();
      f.setStatus({ ok: true, data: { status } });
      const data = createRealPanelData(f.host, f.client, "app");
      expect(await data.revoke("c1"), status).toEqual({ ok: true, cid: "c1" });
      expect(f.calls.revoke, status).toEqual(["c1"]);
    }
  });

  test("a status NOT_FOUND then a failed revoke returns that failure's code and keeps the listed row", async () => {
    const f = makeFakes();
    f.setQuery({ ok: true, data: { schemaVersion: 2, items: [delegation("c1")] } });
    f.setStatus({ ok: false, error: { code: "NOT_FOUND", message: "no", service: "delegation" } });
    f.setRevoke({ ok: false, error: { code: "NETWORK_ERROR", message: "down", service: "delegation" } });
    const data = createRealPanelData(f.host, f.client, "app");
    await data.delegations();
    expect(f.calls.query).toBe(1);

    expect(await data.revoke("c1")).toEqual({ ok: false, code: "NETWORK_ERROR" });
    expect(f.calls.revoke).toEqual(["c1"]);
    expect(f.calls.query).toBe(1);
    const view = await data.delegations();
    expect(view.state).toBe("ready");
    if (view.state === "ready") expect(view.data.rows.map((row) => row.cid)).toEqual(["c1"]);
  });

  test("a status of revoked ends it without calling revoke", async () => {
    const f = makeFakes();
    f.setStatus({ ok: true, data: { status: "revoked" } });
    expect(await createRealPanelData(f.host, f.client, "app").revoke("c1")).toEqual({ ok: false, code: "not-revocable" });
    expect(f.calls.revoke).toEqual([]);
  });

  describe("when the revoke call itself answers NOT_FOUND", () => {
    const notFound = { ok: false, error: { code: "NOT_FOUND", message: "no", service: "delegation" } };

    function setup() {
      const f = makeFakes();
      f.setQuery({ ok: true, data: { schemaVersion: 2, items: [delegation("c1")] } });
      f.setRevoke(notFound);
      const data = createRealPanelData(f.host, f.client, "app");
      return { f, data };
    }

    test("it is ended only when the fresh list no longer holds the grant", async () => {
      const { f, data } = setup();
      await data.delegations();
      f.setQuery({ ok: true, data: { schemaVersion: 2, items: [] } });
      expect(await data.revoke("c1")).toEqual({ ok: false, code: "NOT_FOUND" });
      expect(f.calls.query).toBe(2);
    });

    test("a grant the fresh list still shows as active is a plain failure and the row is kept", async () => {
      const { f, data } = setup();
      await data.delegations();
      expect(await data.revoke("c1")).toEqual({ ok: false, code: "REVOCATION_FAILED" });
      expect(f.calls.query).toBe(2);
      const view = await data.delegations();
      if (view.state === "ready") expect(view.data.rows.map((row) => row.cid)).toEqual(["c1"]);
      else throw new Error(view.state);
    });

    test("a failed re-read is a plain failure, never ended, and the row is kept", async () => {
      const { f, data } = setup();
      await data.delegations();
      f.setQuery({ ok: false, error: { code: "NETWORK_ERROR", message: "down", service: "delegation" } });
      expect(await data.revoke("c1")).toEqual({ ok: false, code: "REVOCATION_FAILED" });
      const view = await data.delegations();
      if (view.state === "ready") expect(view.data.rows.map((row) => row.cid)).toEqual(["c1"]);
      else throw new Error(view.state);
    });
  });
});

describe("createRealPanelData storage", () => {
  test("denied space/info maps to needs-permission", async () => {
    const f = makeFakes();
    f.setStorage({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "no", service: "storage" },
    });
    const data = createRealPanelData(f.host, f.client, "app");

    const view = await data.storage();
    expect(view.state).toBe("needs-permission");
  });

  test("an auth failure (rejected or expired session) maps to needs-permission, never the generic error", async () => {
    const f = makeFakes();
    f.setStorage({
      ok: false,
      error: { code: "AUTH_UNAUTHORIZED", message: "expired", service: "storage" },
    });
    const view = await createRealPanelData(f.host, f.client, "app").storage();
    expect(view).toEqual({ state: "needs-permission", ability: "space/info" });
  });

  test("an unsupported node stays an error with its code, which the page renders as unavailable", async () => {
    const f = makeFakes();
    f.setStorage({ ok: false, error: { code: "unsupported", message: "no", service: "storage" } });
    const view = await createRealPanelData(f.host, f.client, "app").storage();
    expect(view).toEqual({ state: "error", code: "unsupported" });
  });

  test("any other failure keeps its code as a retryable error", async () => {
    const f = makeFakes();
    f.setStorage({ ok: false, error: { code: "NETWORK_ERROR", message: "down", service: "storage" } });
    const view = await createRealPanelData(f.host, f.client, "app").storage();
    expect(view).toEqual({ state: "error", code: "NETWORK_ERROR" });
  });
});
