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
  ViewResult,
} from "../data";
import { viewReady } from "../view-result";

/** Per-view results a preview or test can pin. One optional field per section; absent fields keep the defaults below. */
export interface StubSeed {
  storage?: ViewResult<StorageView>;
}

export function createStubPanelData(seed: StubSeed = {}): PanelDataFactory {
  return (client) => {
    const requests: RequestsView = {
      rows: () => [],
      subscribe: () => () => undefined,
    };

    return {
      // A sync facade change re-reads only the local-copy view.
      subscribe(listener) {
        return client.sync?.subscribe(() => listener("copy" satisfies PanelView)) ?? (() => undefined);
      },
      account: () => Promise.resolve(viewReady<AccountInfo>(STUB_ACCOUNT)),
      localNode: () =>
        Promise.resolve(viewReady<LocalNodeState>({ source: "stub", connection: "off" })),
      // Stub: reports success without changing the reported connection state.
      setLocalNodeEnabled: () => Promise.resolve<ActionResult>({ ok: true }),
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
          seed.storage ??
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
