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
  RequestsView,
  RevokeOutcome,
  StorageView,
} from "../data";
import { viewReady } from "../view-result";

export interface StubSeed {
  /**
   * Local TinyCloud state. Default: off. Enabling moves off -> looking -> found,
   * or -> not-found when this is `not-found`.
   */
  localNode?: LocalNodeState;
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
    const requests: RequestsView = {
      rows: () => [],
      subscribe: () => () => undefined,
    };
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
          viewReady<LocalCopyStatus>({
            source: "stub",
            fieldSources: { requested: "real", effective: "real", reason: "real" },
            requested: state?.requested ?? false,
            effective: state?.effective ?? "unavailable",
            reason: state?.reason,
            folders: [STUB_FOLDER],
            pending: 0,
          }),
        );
      },
      delegations: () => Promise.resolve(viewReady<DelegationPage>({ rows: [STUB_DELEGATION] })),
      revoke: (cid: string) => Promise.resolve<RevokeOutcome>({ ok: true, cid }),
      nodes: () => Promise.resolve(viewReady<readonly NodeRow[]>([STUB_NODE])),
      storage: () =>
        Promise.resolve(
          viewReady<StorageView>({
            source: "stub",
            usedBytes: 1_073_741_824,
            limitBytes: 5_368_709_120,
            state: "ok",
            manageUrl: STORAGE_MANAGE_URL,
          }),
        ),
      requests: () => requests,
    } satisfies PanelDataSource;
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
