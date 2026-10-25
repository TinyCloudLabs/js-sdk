/**
 * Data contract for the settings panel shell (TC-848 P1).
 *
 * Types only. No behaviour lives in this module.
 *
 * Source tags:
 * - `source` on a record: `"real"` when read from an SDK accessor that exists
 *   today, `"stub"` for labelled placeholders, `"derived"` for values computed
 *   from real fields.
 * - `fieldSources` on a record: per-field override for partially real records.
 *   Absent means every field carries the record's `source`.
 *
 * Panel code reads these shapes through a `PanelDataSource`. It never reads
 * TinyCloudWeb directly.
 */

import type {
  AccountDelegationRecord,
  AccountService,
  AccountStatus,
  DelegationManager,
  IStorageService,
  StorageStatus,
  StorageUsage,
} from "@tinycloud/sdk-core";

import type { PanelClient, SyncState } from "./slots";

export type DataSource = "real" | "stub" | "derived";

/** Per-field source for records that mix real and stub fields. */
export type FieldSources = Readonly<Record<string, DataSource>>;

/** Common source metadata on every record the panel renders. */
export interface Tagged {
  readonly source: DataSource;
  readonly fieldSources?: FieldSources;
}

// ---------------------------------------------------------------------------
// Views (mockup nav: overview, local, copy, delegations, nodes, storage, activity)
// ---------------------------------------------------------------------------

export const PANEL_VIEWS = [
  "overview",
  "local",
  "copy",
  "delegations",
  "nodes",
  "storage",
  "activity",
] as const;

export type PanelView = (typeof PANEL_VIEWS)[number];

/** `#/panel[/view]` renders the drawer; `#/page[/view]` renders the full page. */
export type PanelLayout = "panel" | "page";

export interface PanelRoute {
  readonly layout: PanelLayout;
  readonly view: PanelView;
}

// ---------------------------------------------------------------------------
// Read states. Every panel read resolves to one of these, never bare data.
// ---------------------------------------------------------------------------

/**
 * Capabilities the panel may ask the user to allow. Names match the SDK
 * capability strings without the `tinycloud.` prefix.
 */
export type PermissionAbility = "delegation/list" | "space/info" | "space/list";

/** Read freshness, attached to ready results by the live adapter. */
export interface Freshness {
  /** When the shown data was last read successfully (epoch ms). */
  readonly updatedAt: number;
  /** A refresh is in flight. */
  readonly refreshing: boolean;
  /** Code of the last refresh that failed. Cleared by the next success. */
  readonly lastError?: string;
}

export type ViewResult<T> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly data: T; readonly freshness?: Freshness }
  | { readonly state: "needs-permission"; readonly ability: PermissionAbility }
  | { readonly state: "error"; readonly code: string };

/** Result of a write action (toggle, revoke). */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly code: string };

// ---------------------------------------------------------------------------
// Account (real: tc.account.status(), tc.did, tc.sessionDid)
// ---------------------------------------------------------------------------

export interface AccountInfo extends Tagged, Omit<AccountStatus, "applications" | "spaces"> {
  /** Indexed application count. Absent while the account index does not exist yet: unknown, never 0. */
  readonly applications?: number;
  /** Indexed space count. Absent while the account index does not exist yet: unknown, never 0. */
  readonly spaces?: number;
  /** ENS name when one resolves. No SDK source today, so absent or stub. */
  readonly displayName?: string;
  /** Stub: no public getter for session expiry. */
  readonly sessionExpiresAt?: Date;
  /** Name of the app this panel is running inside. */
  readonly appName: string;
  /** Host of the app origin, when the app is embedded. */
  readonly appHost?: string;
}

// ---------------------------------------------------------------------------
// Local node. No public connection-state accessor on TinyCloudWeb yet.
// `url` is real when `localNodeUrl` is configured; `identity` is real when
// `activeNodeIdentity()` resolves.
// ---------------------------------------------------------------------------

export type LocalNodeConnection = "off" | "looking" | "found" | "not-found" | "unavailable";

export interface LocalNodeState extends Tagged {
  /** Stub today. */
  readonly connection: LocalNodeConnection;
  readonly url?: string;
  readonly identity?: { readonly origin: string; readonly nodeDid: string };
  /** Stub until the node reports its version. */
  readonly version?: string;
}

// ---------------------------------------------------------------------------
// Local copy (live sync).
// `requested`, `effective`, `reason` come from the `SyncFacade` on
// `PanelClient.sync`. Toggle and wipe go through that facade, not through
// `PanelDataSource`. `lastSyncedAt`, `folders`, `pending`, `bytesOnDevice`
// have no facade field today; they need a replication status read.
// ---------------------------------------------------------------------------

/**
 * One replicated folder. `items`, `bytes` and `waiting` are STUB in P1: no real
 * per-folder status read exists yet (W4). Real records leave them absent.
 */
export interface LocalFolder {
  readonly prefix: string;
  readonly state: "syncing" | "ok" | "paused";
  readonly items?: number;
  readonly bytes?: number;
  readonly waiting?: number;
}

export interface LocalCopyStatus extends Tagged, SyncState {
  readonly lastSyncedAt?: Date;
  readonly folders: readonly LocalFolder[];
  readonly pending: number;
  readonly bytesOnDevice?: number;
}

// ---------------------------------------------------------------------------
// Delegations (real: tc.delegations.query() / revoke()).
// Field names and status values match `AccountDelegationRecord`
// (sdk-core/src/delegations/types.schema.ts). There is no friendly name,
// kind, or terminal flag in the record.
// ---------------------------------------------------------------------------

export type DelegationStatus = AccountDelegationRecord["status"];

/**
 * Computed in the mapper, never stored:
 * - `this-app`: `delegateDid` equals the current session DID (`tc.sessionDid`).
 * - `to-others`: `direction === "granted"` and the delegate is another DID.
 * - `received`: `direction === "received"`.
 */
export type DelegationGroup = "this-app" | "to-others" | "received";

export interface DelegationResource {
  readonly resource: string;
  readonly actions: readonly string[];
}

/** Plain-words rendering of a resource list. `chips` keeps raw action names for unknown ones. */
export interface DescribedAbilities {
  readonly plain: string;
  readonly chips: readonly string[];
}

export interface DelegationRow extends Tagged {
  readonly cid: string;
  readonly direction: AccountDelegationRecord["direction"];
  readonly status: DelegationStatus;
  /** Derived in the mapper. */
  readonly group: DelegationGroup;
  /** Friendly name when resolvable, else the short DID. */
  readonly label: { readonly text: string; readonly source: "derived" | "stub" };
  readonly delegatorDid: string;
  readonly delegateDid: string;
  readonly resources: readonly DelegationResource[];
  /** Parent delegation CIDs. */
  readonly parents: readonly string[];
  readonly issuedAt: Date | null;
  readonly notBefore: Date | null;
  readonly expiresAt: Date | null;
  /** Derived: `expiresAt` falls within 24 h of now. */
  readonly expiringSoon: boolean;
  readonly revokedAt?: AccountDelegationRecord["revokedAt"];
  readonly revokedBy?: AccountDelegationRecord["revokedBy"];
  readonly revokedAncestorCid?: AccountDelegationRecord["revokedAncestorCid"];
  /**
   * Terminal marker. The account record does not carry it. The real mapper
   * never sets it. Stub data sets it with `fieldSources.terminal = "stub"`.
   */
  readonly terminal?: boolean;
}

export interface DelegationPage {
  readonly rows: readonly DelegationRow[];
  /** Pass back as `cursor` to fetch the next page. Absent on the last page. */
  readonly nextCursor?: string;
}

/**
 * Result of `revoke(cid)`. The SDK receipt is `{ revoked: true, cid }`.
 * `code` is the SDK error code, or a neutral code when none is given.
 */
export type RevokeOutcome =
  | { readonly ok: true; readonly cid: string }
  | { readonly ok: false; readonly code: string };

// ---------------------------------------------------------------------------
// Nodes. Real: tc.hosts, activeNodeIdentity(), localNodeUrl.
// Status, latency, version, last-seen and spaces are stubs today.
// ---------------------------------------------------------------------------

export type NodeKind = "hosted" | "local";
export type NodeStatus = "ok" | "slow" | "down";

export interface NodeRow extends Tagged {
  /** Real: from `tc.hosts`. */
  readonly origin: string;
  /** Real: local when the origin is `localNodeUrl`, else hosted. */
  readonly kind: NodeKind;
  /** Real: true for the node in `activeNodeIdentity()`. */
  readonly active: boolean;
  /** Real for the active node only. */
  readonly nodeDid?: string;
  /** Stub until latency is measured. */
  readonly status: NodeStatus;
  /** Stub: the node `/info` call is not wrapped in the SDK. */
  readonly version?: string;
  /** Stub until latency is measured. */
  readonly latencyMs?: number;
  readonly lastSeenAt?: Date;
  /** Stub: space names are not mapped to nodes yet. */
  readonly spaces: readonly string[];
}

// ---------------------------------------------------------------------------
// Storage (real: tc.storage.status(); per-space needs tinycloud.space/info,
// which default sessions do not request).
// `perSpace` is not populated in P1. It is declared so the view can add it
// without a contract change.
// ---------------------------------------------------------------------------

export interface SpaceUsageRow extends Tagged {
  readonly space: string;
  readonly usage: StorageUsage;
}

export interface StorageView extends Tagged, StorageStatus {
  readonly perSpace?: readonly SpaceUsageRow[];
}

// ---------------------------------------------------------------------------
// Plain-words ability description (implemented in S2).
// Declared here so the signature is fixed before the view is written.
// Known actions map to words (`tinycloud.kv/get` -> "read",
// `tinycloud.kv/list` -> "list", `tinycloud.kv/put` -> "write",
// `tinycloud.kv/del` -> "delete"). Unknown actions appear raw in `chips`.
// ---------------------------------------------------------------------------

export declare function describeAbilities(
  resources: readonly DelegationResource[],
): DescribedAbilities;

// ---------------------------------------------------------------------------
// SDK surface the real adapter reads. Narrow on purpose, so tests can pass a
// fake object without a full TinyCloudWeb.
// ---------------------------------------------------------------------------

export interface PanelDataHost {
  readonly account: Pick<AccountService, "index">;
  readonly delegations: Pick<DelegationManager, "query" | "revoke" | "status">;
  readonly storage: Pick<IStorageService, "status">;
  readonly hosts: readonly string[];
  /** Current account DID (`tc.did`). */
  readonly did: string;
  /** Session DID (`tc.sessionDid`). Compared against `delegateDid` for `this-app`. */
  readonly sessionDid: string;
  activeNodeIdentity(): Promise<{ readonly origin: string; readonly nodeDid: string }>;
}

// ---------------------------------------------------------------------------
// Panel data source. The shell reads every view through this.
// Reads resolve to `ViewResult`. Writes resolve to a result object.
// Local copy toggle and wipe are not here: they go through `PanelClient.sync`.
// ---------------------------------------------------------------------------

export interface PanelDataSource {
  /** Fires when any view's data changes (toggle, revoke, stub change). Returns unsubscribe. */
  subscribe(listener: (view: PanelView) => void): () => void;

  /**
   * Account DID this source reads for, known without a network read. Lets Overview keep the identity on
   * screen when the account read fails. Absent on sources that cannot tell.
   */
  knownDid?(): string | undefined;

  account(): Promise<ViewResult<AccountInfo>>;

  localNode(): Promise<ViewResult<LocalNodeState>>;
  /** Stub today. */
  setLocalNodeEnabled(on: boolean): Promise<ActionResult>;

  localCopy(): Promise<ViewResult<LocalCopyStatus>>;

  /** Pass `cursor` from the previous page's `nextCursor`. */
  delegations(cursor?: string): Promise<ViewResult<DelegationPage>>;
  revoke(cid: string): Promise<RevokeOutcome>;

  nodes(): Promise<ViewResult<readonly NodeRow[]>>;

  /** `fresh` awaits a network read now. Otherwise a cached value is returned, refreshed in the background only when stale. */
  storage(options?: { readonly fresh?: boolean }): Promise<ViewResult<StorageView>>;
}

/** Builds the data source for one registered client. */
export type PanelDataFactory = (client: PanelClient) => PanelDataSource;
