/**
 * Stub panel data for preview and tests. Every value is labelled `source: "stub"`,
 * except the local-copy state, which is read from the client's sync facade.
 *
 * Preview and tests only. The SDK real path never imports this module (TC-1749).
 */

import { STORAGE_MANAGE_URL } from "../manage-url";
import type {
  AccountInfo,
  ActionResult,
  DelegationPage,
  DelegationRow,
  LocalCopyStatus,
  LocalNodeState,
  NodeRow,
  PanelDataFactory,
  PanelDataSource,
  PanelView,
  RevokeOutcome,
  StorageView,
  ViewResult,
} from "../data";
import { viewReady } from "../view-result";

/**
 * Per-view stub overrides, so a preview or e2e spec can reach states the defaults never produce.
 * One optional field per section; a missing field keeps that section's default.
 */
export interface StubSeed {
  storage?: ViewResult<StorageView>;
  nodes?: ViewResult<readonly NodeRow[]>;
  delegations?: StubDelegationsSeed;
  /**
   * Local TinyCloud state. Default: off. Enabling moves off -> looking -> found,
   * or -> not-found when this is `not-found`.
   */
  localNode?: LocalNodeState;
  /** Local copy status. Replaces the default (a settled copy that follows the sync facade). */
  readonly localCopy?: LocalCopyStatus;
}

const STUB_LOCAL_SETTLE_MS = 600;

const STUB_LOCAL_FOUND: LocalNodeState = {
  source: "stub",
  connection: "found",
  url: "http://127.0.0.1:8787",
  identity: { origin: "http://127.0.0.1:8787", nodeDid: "did:example:stub-local-node" },
  version: "v0.14.2",
};

export function createStubPanelData(seed: StubSeed = {}): PanelDataFactory {
  return (client) => {
    const localListeners = new Set<(view: PanelView) => void>();
    let localNode: LocalNodeState = seed.localNode ?? { source: "stub", connection: "off" };
    let pending: { timer: ReturnType<typeof setTimeout>; resolve: (result: ActionResult) => void } | undefined;

    const setLocalNode = (next: LocalNodeState): void => {
      localNode = next;
      for (const listener of localListeners) listener("local");
    };

    return {
      // A sync facade change re-reads only the local-copy view.
      subscribe(listener) {
        localListeners.add(listener);
        const unsubscribeSync =
          client.sync?.subscribe(() => listener("copy" satisfies PanelView)) ?? (() => undefined);
        return () => {
          localListeners.delete(listener);
          unsubscribeSync();
        };
      },
      account: () => Promise.resolve(viewReady<AccountInfo>(STUB_ACCOUNT)),
      localNode: () => Promise.resolve(viewReady<LocalNodeState>(localNode)),
      // Stub: a short timer stands in for the real check. Cancelling while looking
      // (switch off) clears the timer and settles the pending enable as ok.
      setLocalNodeEnabled: (on: boolean) => {
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve({ ok: true });
          pending = undefined;
        }
        if (!on) {
          setLocalNode({ source: "stub", connection: "off" });
          return Promise.resolve<ActionResult>({ ok: true });
        }
        setLocalNode({ source: "stub", connection: "looking" });
        return new Promise<ActionResult>((resolve) => {
          const timer = setTimeout(() => {
            pending = undefined;
            setLocalNode(
              seed.localNode && seed.localNode.connection === "not-found"
                ? seed.localNode
                : STUB_LOCAL_FOUND,
            );
            resolve({ ok: true });
          }, STUB_LOCAL_SETTLE_MS);
          pending = { timer, resolve };
        });
      },
      localCopy: () => {
        const state = client.sync?.state;
        return Promise.resolve(
          viewReady<LocalCopyStatus>(
            seed.localCopy ?? {
              source: "stub",
              fieldSources: { requested: "real", effective: "real", reason: "real" },
              requested: state?.requested ?? false,
              effective: state?.effective ?? "unavailable",
              reason: state?.reason,
              folders: [STUB_FOLDER],
              pending: 0,
            },
          ),
        );
      },
      ...delegationsStub(seed.delegations),
      nodes: () => Promise.resolve(seed.nodes ?? viewReady<readonly NodeRow[]>([STUB_NODE])),
      storage: () =>
        Promise.resolve(
          seed.storage ??
          viewReady<StorageView>({
            source: "stub",
            usedBytes: 1_073_741_824,
            limitBytes: 5_368_709_120,
            state: "ok",
            manageUrl: STORAGE_MANAGE_URL,
          }),
        ),
    } satisfies PanelDataSource;
  };
}

/** A delegation row as a JSON seed: dates are ISO strings, and `source` is always "stub". */
export type StubDelegationRowSeed = Omit<DelegationRow, "source" | "issuedAt" | "notBefore" | "expiresAt" | "revokedAt"> & {
  readonly issuedAt?: string | null;
  readonly notBefore?: string | null;
  readonly expiresAt?: string | null;
  readonly revokedAt?: string | null;
};

/** Delegations a preview or test can pin. Absent fields keep the one-row default. */
export interface StubDelegationsSeed {
  /** The read state of the first page. Default: ready. */
  readonly state?: "ready" | "loading" | "needs-permission" | "error";
  readonly rows?: readonly StubDelegationRowSeed[];
  readonly nextCursor?: string;
  /** Pages after the first, by the cursor that reads them. */
  readonly pages?: Readonly<Record<string, { readonly rows: readonly StubDelegationRowSeed[]; readonly nextCursor?: string }>>;
  /** Failure code `revoke(cid)` returns for a CID, with the row left as it is. */
  readonly revokeFails?: Readonly<Record<string, string>>;
  /** Milliseconds `revoke` waits before it answers. */
  readonly revokeDelayMs?: number;
}

function seededDate(value: string | null | undefined): Date | null {
  return typeof value === "string" ? new Date(value) : null;
}

/**
 * Delegations that behave like the real adapter: a revoke of an active row marks it revoked, and a row that is not
 * active is refused with `not-revocable`. A CID the list does not hold is accepted, as before.
 */
function delegationsStub(seed: StubDelegationsSeed = {}): Pick<PanelDataSource, "delegations" | "revoke"> {
  const toRow = ({ revokedAt, ...row }: StubDelegationRowSeed): DelegationRow => ({
    ...row,
    source: "stub",
    issuedAt: seededDate(row.issuedAt),
    notBefore: seededDate(row.notBefore),
    expiresAt: seededDate(row.expiresAt),
    ...(revokedAt === undefined ? {} : { revokedAt: seededDate(revokedAt) }),
  });
  const rows: DelegationRow[] = seed.rows === undefined ? [STUB_DELEGATION] : seed.rows.map(toRow);
  const later = new Map<string, { rows: DelegationRow[]; nextCursor?: string }>(
    Object.entries(seed.pages ?? {}).map(([cursor, page]) => [
      cursor,
      { rows: page.rows.map(toRow), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) },
    ]),
  );
  return {
    delegations: (cursor?: string) => {
      const state = seed.state ?? "ready";
      if (state === "loading") return Promise.resolve<ViewResult<DelegationPage>>({ state });
      if (state === "needs-permission") return Promise.resolve<ViewResult<DelegationPage>>({ state, ability: "delegation/list" });
      if (state === "error") return Promise.resolve<ViewResult<DelegationPage>>({ state, code: "unknown" });
      if (cursor !== undefined) {
        const page = later.get(cursor);
        return Promise.resolve<ViewResult<DelegationPage>>(
          page === undefined ? { state: "error", code: "unknown-cursor" } : viewReady<DelegationPage>({ ...page, rows: [...page.rows] }),
        );
      }
      return Promise.resolve(
        viewReady<DelegationPage>({ rows: [...rows], ...(seed.nextCursor === undefined ? {} : { nextCursor: seed.nextCursor }) }),
      );
    },
    revoke: async (cid: string): Promise<RevokeOutcome> => {
      // The lib target has no Promise.withResolvers, so this uses the executor form.
      if (seed.revokeDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, seed.revokeDelayMs));
      const code = seed.revokeFails?.[cid];
      if (code !== undefined) return { ok: false, code };
      for (const list of [rows, ...[...later.values()].map((page) => page.rows)]) {
        const at = list.findIndex((row) => row.cid === cid);
        const found = list[at];
        if (found === undefined) continue;
        if (found.status !== "active") return { ok: false, code: "not-revocable" };
        list[at] = { ...found, status: "revoked", revokedAt: new Date() };
        return { ok: true, cid };
      }
      return { ok: true, cid };
    },
  };
}

const STUB_ACCOUNT: AccountInfo = {
  source: "stub",
  did: "did:example:stub-account",
  host: "https://stub.invalid",
  applications: 2,
  spaces: 1,
  grantedDelegations: 3,
  receivedDelegations: 1,
  appName: "Stub app",
  sessionExpiresAt: new Date(Date.now() + 3 * 3_600_000 + 14 * 60_000),
};

const STUB_DELEGATION: DelegationRow = {
  source: "stub",
  cid: "bafy-stub-delegation-1",
  direction: "granted",
  status: "active",
  group: "to-others",
  label: { text: "Stub grant", source: "stub" },
  delegatorDid: "did:example:stub-account",
  delegateDid: "did:example:stub-other",
  resources: [{ resource: "tinycloud.kv/", actions: ["get", "list"] }],
  parents: [],
  issuedAt: null,
  notBefore: null,
  expiresAt: null,
  expiringSoon: false,
};

const STUB_NODE: NodeRow = {
  source: "stub",
  origin: "https://node.invalid",
  kind: "hosted",
  active: false,
  status: "ok",
  spaces: [],
};

const STUB_FOLDER = { prefix: "notes/", state: "ok", items: 12, bytes: 48_000 } as const;
