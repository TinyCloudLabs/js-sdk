import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";

import type { PanelDataHost } from "../../src/ui/data";
import { delegationQuerySpaces, sessionHolds } from "../../src/ui/data/authority";
import { createPanelPrefetch } from "../../src/ui/data/prefetch";
import { createRealPanelData } from "../../src/ui/data/real";
import type { PanelClient } from "../../src/ui/slots";

const ACCOUNT_SPACE = "tinycloud:pkh:eip155:1:0xowner:account";
const OWN_SPACE = "tinycloud:pkh:eip155:1:0xowner:applications";

const ACCOUNT_SQL_READ = "tinycloud.sql/read@account";
const accountDelegationList = `tinycloud.delegation/list@${ACCOUNT_SPACE}`;
const ownDelegationList = `tinycloud.delegation/list@${OWN_SPACE}`;
const ownSpaceInfo = `tinycloud.space/info@${OWN_SPACE}`;

/** What the session holds, as `<action>@<space or "account">` keys. */
function holds(grants: readonly string[]) {
  return (entries: PermissionEntry[]): boolean =>
    entries.every((entry) => entry.actions.every((action) => grants.includes(`${action}@${entry.space}`)));
}

interface Counts {
  spacesList: number;
  applicationsList: number;
  query: number;
  querySpaces: Array<readonly string[] | undefined>;
  storage: number;
}

type Refusal = "none" | "401" | "403" | "5xx";

function makeHost(grants: readonly string[] | "unknown", refusal: Refusal = "none") {
  const counts: Counts = { spacesList: 0, applicationsList: 0, query: 0, querySpaces: [], storage: 0 };
  const indexRead = async (counter: "spacesList" | "applicationsList") => {
    counts[counter] += 1;
    if (refusal === "401") return { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "401" } };
    if (refusal === "403") return { ok: false, error: { code: "PERMISSION_DENIED", message: "403" } };
    if (refusal === "5xx") return { ok: false, error: { code: "NETWORK_ERROR", message: "503" } };
    return { ok: true, data: [] };
  };
  const host = {
    did: "did:key:account",
    sessionDid: "did:key:session",
    hosts: ["https://node.example"],
    accountSpaceId: ACCOUNT_SPACE,
    spaceId: OWN_SPACE,
    ...(grants === "unknown" ? {} : { hasPermissions: holds(grants) }),
    account: {
      index: {
        spaces: { list: () => indexRead("spacesList") },
        applications: { list: () => indexRead("applicationsList") },
      },
    },
    delegations: {
      query: async (_options: unknown, scope?: { spaces?: readonly string[] }) => {
        counts.query += 1;
        counts.querySpaces.push(scope?.spaces);
        return { ok: true, data: { schemaVersion: 2, items: [] } };
      },
    },
    storage: {
      status: async () => {
        counts.storage += 1;
        return { ok: true, data: { state: "ok" } };
      },
    },
    activeNodeIdentity: async () => undefined,
  } as unknown as PanelDataHost;
  return { host, counts };
}

const client = { onReset: () => () => {} } as unknown as PanelClient;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** The prefetch as the panel arms it: idle and registry gates already open. */
async function prefetch(host: PanelDataHost) {
  const data = createRealPanelData(host, client, "app");
  createPanelPrefetch({
    data,
    idle: () => Promise.resolve(),
    registrySettled: () => Promise.resolve(),
    onReset: () => () => {},
  });
  await flush();
  return data;
}

/** Captures timers so the 5 s account retry can be fired by hand. */
const realSetTimeout = globalThis.setTimeout;
let timers: Array<{ cb: () => void; ms: number | undefined }> = [];
beforeEach(() => {
  timers = [];
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    timers.push({ cb, ms });
    return 0;
  }) as unknown as typeof setTimeout;
});
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

const retryTimers = () => timers.filter((t) => t.ms === 5_000);

describe("panel prefetch without account grants", () => {
  test("sends no account index read and no delegation query when the session holds neither", async () => {
    const { host, counts } = makeHost([]);
    const data = await prefetch(host);

    expect(counts.spacesList).toBe(0);
    expect(counts.applicationsList).toBe(0);
    expect(counts.query).toBe(0);
    expect(await data.account()).toEqual({ state: "error", code: "not-granted" });
    expect(await data.delegations()).toEqual({ state: "needs-permission", ability: "delegation/list" });
    expect(retryTimers()).toHaveLength(0);
    // Storage is not read either, and answers with the needs-permission state a refusal gives.
    expect(counts.storage).toBe(0);
    expect(await data.storage()).toEqual({ state: "needs-permission", ability: "space/info" });
  });

  test("queries only the own space when the account-space grant is absent", async () => {
    const { host, counts } = makeHost([ownDelegationList]);
    await prefetch(host);

    expect(counts.query).toBe(1);
    expect(counts.querySpaces).toEqual([[OWN_SPACE]]);
    expect(counts.spacesList).toBe(0);
  });

  test("an account index grant alone reads the index and sends no delegation query", async () => {
    const { host, counts } = makeHost([ACCOUNT_SQL_READ]);
    const data = await prefetch(host);

    expect(counts.spacesList).toBe(1);
    expect(counts.applicationsList).toBe(1);
    expect(counts.query).toBe(0);
    expect((await data.account()).state).toBe("ready");
  });
});

describe("panel prefetch with account grants", () => {
  test("makes the same requests as before: both index reads, one query signed for account then own space", async () => {
    const { host, counts } = makeHost([ACCOUNT_SQL_READ, accountDelegationList, ownDelegationList, ownSpaceInfo]);
    const data = await prefetch(host);

    expect(counts.spacesList).toBe(1);
    expect(counts.applicationsList).toBe(1);
    expect(counts.query).toBe(1);
    expect(counts.querySpaces).toEqual([[ACCOUNT_SPACE, OWN_SPACE]]);
    expect(counts.storage).toBe(1);
    expect((await data.account()).state).toBe("ready");
  });

  test("a host that cannot tell leaves the query to the SDK's own space choice", async () => {
    const { host, counts } = makeHost("unknown");
    await prefetch(host);

    expect(counts.spacesList).toBe(1);
    expect(counts.query).toBe(1);
    expect(counts.querySpaces).toEqual([undefined]);
  });
});

describe("account read retry", () => {
  test("a 403 on the index read schedules no retry timer", async () => {
    const { host, counts } = makeHost([ACCOUNT_SQL_READ], "403");
    const data = await prefetch(host);

    expect(await data.account()).toEqual({ state: "error", code: "PERMISSION_DENIED" });
    expect(retryTimers()).toHaveLength(0);
    expect(timers).toHaveLength(0);
    expect(counts.spacesList).toBe(1);
  });

  test("a 401 on the index read is not retried", async () => {
    const { host, counts } = makeHost([ACCOUNT_SQL_READ], "401");
    const data = await prefetch(host);

    expect(await data.account()).toEqual({ state: "error", code: "AUTH_UNAUTHORIZED" });
    expect(retryTimers()).toHaveLength(0);
    expect(counts.spacesList).toBe(1);
  });

  test("a 5xx on the index read is retried once after 5 s", async () => {
    const { host, counts } = makeHost([ACCOUNT_SQL_READ], "5xx");
    await prefetch(host);

    expect(counts.spacesList).toBe(1);
    expect(retryTimers()).toHaveLength(1);

    const [retry] = retryTimers();
    timers = [];
    retry!.cb();
    await flush();
    // The retry re-reads the index once; a second failure is not retried again.
    expect(counts.spacesList).toBe(2);
    expect(retryTimers()).toHaveLength(0);
  });
});

describe("sessionHolds / delegationQuerySpaces", () => {
  test("a host without hasPermissions holds everything and picks no spaces", () => {
    expect(sessionHolds({}, { service: "tinycloud.sql", path: "account", actions: ["tinycloud.sql/read"] })).toBe(true);
    expect(delegationQuerySpaces({ accountSpaceId: ACCOUNT_SPACE, spaceId: OWN_SPACE })).toBeUndefined();
  });

  test("the own space is listed once when it is the account space", () => {
    const host = { hasPermissions: () => true, accountSpaceId: ACCOUNT_SPACE, spaceId: ACCOUNT_SPACE };
    expect(delegationQuerySpaces(host)).toEqual([ACCOUNT_SPACE]);
  });
});
