import type {
  AccountInfo,
  ActionResult,
  DelegationPage,
  LocalCopyStatus,
  LocalNodeState,
  NodeRow,
  PanelDataHost,
  PanelDataSource,
  PanelView,
  RevokeOutcome,
  StorageView,
  ViewResult,
} from "../data";
import type { PanelClient } from "../slots";
import { viewError, viewLoading, viewNeedsPermission, viewReady } from "../view-result";

import { toDelegationRow } from "./map";

/** One bounded retry for a first account read that failed (no ready value yet). */
const ACCOUNT_RETRY_MS = 5_000;

/**
 * The account index tables are created by the first index write, so a brand-new account reads
 * "no such table". The SDK's SQL read fails that way with code SQL_ERROR (HTTP 400) and one of two
 * messages (SQLService handleErrorResponse, responseErrors formatServiceResponseError): for the node's
 * plain-text body `SQL query failed: 400 - SQLite error: no such table: <table>`, for a JSON body its
 * parsed message `SQLite error: no such table: <table>`. Only a message that STARTS with that error, for
 * the table THIS read expects, is "not created yet". Any other code, another table (`spaces_old`
 * included) and any error that merely quotes the text (mid-message, in a JSON body, after another
 * prefix) stay errors.
 */
const SQL_ERROR = "SQL_ERROR";
const MISSING_TABLE: Record<"spaces" | "applications", RegExp> = {
  spaces: /^(?:SQL query failed: 400 - )?SQLite error: no such table:\s*spaces\b/i,
  applications: /^(?:SQL query failed: 400 - )?SQLite error: no such table:\s*applications\b/i,
};

/**
 * Count from an index read: a number, `undefined` when the index does not exist yet (unknown, never 0),
 * or the error code (a string) for any other failure.
 */
function indexCount(
  res: { readonly ok: true; readonly data: readonly unknown[] } | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } },
  table: "spaces" | "applications",
): number | string | undefined {
  if (res.ok === true) return res.data.length;
  const missing = res.error.code === SQL_ERROR && MISSING_TABLE[table].test(res.error.message ?? "");
  return missing ? undefined : res.error.code;
}

const ACCOUNT_TTL_MS = 60_000;
const STORAGE_TTL_MS = 60_000;
const DELEGATIONS_TTL_MS = 10_000;
const PAGE_LIMIT = 50;

/** Cached sections. Local node, nodes and local copy read in place (no network). */
type SectionKey = "account" | "delegations" | "storage";

interface Snapshot {
  value?: ViewResult<unknown>;
  /** Epoch ms of the last successful read. */
  at: number;
  /** Epoch ms of the last completed attempt, success or failure. Gates revalidation. */
  checkedAt: number;
  refreshing: boolean;
  /** Code of the last failed refresh. Set while a ready value is kept. */
  lastError?: string;
  /** An account retry is scheduled or spent for the current failure. */
  retried?: boolean;
  /** The pending retry timer. Cleared on reset and when a ready value lands. */
  retryTimer?: ReturnType<typeof setTimeout>;
  inflight?: Promise<void>;
}

const SECTION_VIEWS: Record<SectionKey, readonly PanelView[]> = {
  account: ["overview"],
  delegations: ["delegations"],
  storage: ["storage"],
};

/**
 * Live panel data. Every read is stale-while-revalidate per section:
 * - no snapshot: await one attempt;
 * - fresh snapshot (within TTL): return it;
 * - stale snapshot: return it now and refresh in the background.
 * A failed refresh keeps the previous ready snapshot. Reset (sign-out or
 * account switch) drops all snapshots and discards in-flight results.
 */
export function createRealPanelData(
  host: PanelDataHost,
  client: PanelClient,
  appName: string,
): PanelDataSource {
  const listeners = new Set<(view: PanelView) => void>();
  const snaps = new Map<SectionKey, Snapshot>();
  let epoch = 0;
  const cursors = new Set<string>();

  client.onReset(() => {
    // The pending retry must not fire for an account or a panel that is gone.
    for (const snap of snaps.values()) clearTimeout(snap.retryTimer);
    epoch += 1;
    snaps.clear();
    cursors.clear();
  });

  const snapFor = (key: SectionKey): Snapshot => {
    let snap = snaps.get(key);
    if (!snap) {
      snap = { at: 0, checkedAt: 0, refreshing: false };
      snaps.set(key, snap);
    }
    return snap;
  };

  const emit = (key: SectionKey): void => {
    for (const view of SECTION_VIEWS[key]) {
      for (const listener of listeners) listener(view);
    }
  };

  function refresh<T>(key: SectionKey, fetch: () => Promise<ViewResult<T>>): Promise<void> {
    const snap = snapFor(key);
    if (snap.inflight) return snap.inflight;
    const run = epoch;
    const inflight = fetch()
      .catch((): ViewResult<T> => viewError("unavailable"))
      .then((result) => {
        if (run !== epoch) return;
        if (result.state === "error" && snap.value?.state === "ready") {
          snap.lastError = result.code;
          return;
        }
        snap.value = result;
        snap.at = Date.now();
        snap.lastError = undefined;
        if (result.state === "ready") {
          snap.retried = false;
          clearTimeout(snap.retryTimer);
          snap.retryTimer = undefined;
        }
      })
      .finally(() => {
        if (run !== epoch) return;
        snap.inflight = undefined;
        snap.checkedAt = Date.now();
        snap.refreshing = false;
        emit(key);
        // A first account read that failed gets one more attempt, so an open Overview recovers without
        // the user leaving it. The epoch guard drops it after a reset; a ready value re-arms it.
        if (key === "account" && snap.value?.state === "error" && !snap.retried) {
          snap.retried = true;
          snap.retryTimer = setTimeout(() => {
            snap.retryTimer = undefined;
            if (run === epoch) void refresh(key, fetch);
          }, ACCOUNT_RETRY_MS);
        }
      });
    snap.inflight = inflight;
    snap.refreshing = true;
    emit(key);
    return inflight;
  }

  function present<T>(snap: Snapshot, value: ViewResult<T>): ViewResult<T> {
    if (value.state !== "ready") return value;
    return {
      ...value,
      freshness: { updatedAt: snap.at, refreshing: snap.refreshing, lastError: snap.lastError },
    };
  }

  async function read<T>(
    key: SectionKey,
    ttlMs: number,
    fetch: () => Promise<ViewResult<T>>,
    force = false,
  ): Promise<ViewResult<T>> {
    const snap = snapFor(key);
    if (snap.value === undefined || force) {
      const run = epoch;
      await refresh(key, fetch);
      if (run !== epoch) return viewLoading<T>();
      return snap.value === undefined
        ? viewLoading<T>()
        : present(snap, snap.value as ViewResult<T>);
    }
    if (Date.now() - snap.checkedAt > ttlMs) void refresh(key, fetch);
    return present(snap, snap.value as ViewResult<T>);
  }

  async function fetchDelegations(cursor?: string): Promise<ViewResult<DelegationPage>> {
    const run = epoch;
    const res = await host.delegations.query({
      direction: "all",
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (run !== epoch) return viewError("stale");
    if (res.ok === false) {
      return res.error.code === "PERMISSION_DENIED"
        ? viewNeedsPermission("delegation/list")
        : viewError(res.error.code);
    }
    const now = Date.now();
    if (res.data.nextCursor) cursors.add(res.data.nextCursor);
    return viewReady({
      rows: res.data.items.map((r) => toDelegationRow(r, host.sessionDid, now)),
      ...(res.data.nextCursor ? { nextCursor: res.data.nextCursor } : {}),
    });
  }

  async function fetchAccount(): Promise<ViewResult<AccountInfo>> {
    const [spaces, applications, delegations] = await Promise.all([
      host.account.index.spaces.list(),
      host.account.index.applications.list(),
      read("delegations", DELEGATIONS_TTL_MS, () => fetchDelegations()),
    ]);
    const spaceCount = indexCount(spaces, "spaces");
    if (typeof spaceCount === "string") return viewError(spaceCount);
    const applicationCount = indexCount(applications, "applications");
    if (typeof applicationCount === "string") return viewError(applicationCount);

    // Delegation counts come from the first page only. They are lower bounds
    // when the delegations read is not ready, and are reported as derived.
    const page = delegations.state === "ready" ? delegations.data.rows : undefined;
    const granted = page?.filter((r) => r.direction === "granted").length ?? 0;
    const received = page?.filter((r) => r.direction === "received").length ?? 0;

    return viewReady({
      source: "real",
      fieldSources: { grantedDelegations: "derived", receivedDelegations: "derived" },
      did: host.did,
      host: host.hosts[0] ?? "",
      ...(applicationCount !== undefined ? { applications: applicationCount } : {}),
      ...(spaceCount !== undefined ? { spaces: spaceCount } : {}),
      grantedDelegations: granted,
      receivedDelegations: received,
      appName,
    });
  }

  async function fetchStorage(): Promise<ViewResult<StorageView>> {
    // The SDK fails closed locally (PERMISSION_DENIED, nothing sent) when the
    // space/info grant cannot be confirmed, so this read never reaches the node unauthorised.
    const res = await host.storage.status();
    if (res.ok === false) {
      // An expired or rejected session is a permission problem the user can fix (Allow storage details),
      // never the generic "didn't load".
      return res.error.code === "PERMISSION_DENIED" || res.error.code === "AUTH_UNAUTHORIZED"
        ? viewNeedsPermission("space/info")
        : viewError(res.error.code);
    }
    return viewReady({ source: "real", ...res.data });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    account: () => read("account", ACCOUNT_TTL_MS, fetchAccount),
    // After a reset this source belongs to the previous account.
    knownDid: () => (epoch === 0 ? host.did : undefined),

    async localNode(): Promise<ViewResult<LocalNodeState>> {
      const run = epoch;
      const identity = await host.activeNodeIdentity().catch(() => undefined);
      if (run !== epoch) return viewLoading<LocalNodeState>();
      return viewReady({
        source: "real",
        fieldSources: { connection: "stub", version: "stub" },
        connection: "unavailable",
        ...(identity ? { identity } : {}),
      });
    },

    async setLocalNodeEnabled(): Promise<ActionResult> {
      // Stub today: the local node connection has no toggle in the SDK yet.
      return { ok: false, code: "unavailable" };
    },

    async localCopy(): Promise<ViewResult<LocalCopyStatus>> {
      const sync = client.sync;
      if (!sync) return viewError("unavailable");
      const { requested, effective, reason } = sync.state;
      return viewReady({
        source: "real",
        fieldSources: { lastSyncedAt: "stub", folders: "stub", pending: "stub", bytesOnDevice: "stub" },
        requested,
        effective,
        ...(reason !== undefined ? { reason } : {}),
        folders: [],
        pending: 0,
      });
    },

    delegations(cursor?: string) {
      if (!cursor) return read("delegations", DELEGATIONS_TTL_MS, () => fetchDelegations());
      if (!cursors.has(cursor)) return Promise.resolve(viewError("stale"));
      return fetchDelegations(cursor);
    },

    async revoke(cid: string): Promise<RevokeOutcome> {
      // The node is the arbiter: check the current status before acting.
      const run = epoch;
      const before = await host.delegations.status(cid);
      if (run !== epoch) return { ok: false, code: "stale" };
      if (before.ok === false) return { ok: false, code: before.error.code };
      if (before.data.status !== "active") {
        return { ok: false, code: "not-revocable" };
      }
      const res = await host.delegations.revoke(cid);
      if (res.ok === false) return { ok: false, code: res.error.code };

      // Refetch after the write so the panel shows the node's state.
      snapFor("account").at = 0;
      await refresh("delegations", () => fetchDelegations());
      return { ok: true, cid };
    },

    async nodes(): Promise<ViewResult<readonly NodeRow[]>> {
      const run = epoch;
      const identity = await host.activeNodeIdentity().catch(() => undefined);
      if (run !== epoch) return viewLoading<readonly NodeRow[]>();
      return viewReady(
        host.hosts.map((origin): NodeRow => {
          const active = identity !== undefined && identity.origin === origin;
          return {
            source: "real",
            fieldSources: { kind: "stub", status: "stub", spaces: "stub" },
            origin,
            kind: "hosted",
            active,
            ...(active && identity ? { nodeDid: identity.nodeDid } : {}),
            status: "ok",
            spaces: [],
          };
        }),
      );
    },

    storage: (options) => read("storage", STORAGE_TTL_MS, fetchStorage, options?.fresh === true),
  };
}
