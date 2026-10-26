/**
 * Internal view-slot interface. The only contract the panel sections and
 * always-on parts code against. Panel code never sees TinyCloudWeb.
 */

import type { IStorageService } from "@tinycloud/sdk-core";
import type {
  AccountInfo,
  DelegationPage,
  LocalCopyStatus,
  LocalNodeState,
  NodeRow,
  PanelDataSource,
  StorageView,
  ViewResult,
} from "./data";
import type { ShellLayout } from "./panel";
import type { ReceiptRequest } from "./panel-toasts";
import type { IconName } from "./sections/ui";
import type { StringKey } from "./strings";
import type { UiPlatform } from "./config";
import type { ToastRequest } from "./toast-store";

/** Panel sections, in nav order. Ids match the full-page and sidebar mockup. */
export type SectionId =
  | "account"
  | "local-tinycloud"
  | "local-copy"
  | "delegations"
  | "nodes"
  | "storage"
  | "activity";

/** Priority order lives in status.ts. */
export type StatusCode = "storage_full" | "sync_pending" | "sync_attention";

/** Effective sync state as exposed by the replication facade. */
export type SyncEffective = "off" | "enabling" | "on" | "wiping" | "pending" | "unavailable";

export interface SyncState {
  readonly requested: boolean;
  readonly effective: SyncEffective;
  readonly reason?: string;
}

/** Open string union: unknown codes are rendered as the neutral line. */
export type FacadeErrorCode = "declined" | "unsupported" | "failed" | (string & {});

export interface SyncFacade {
  readonly state: SyncState;
  subscribe(cb: () => void): () => void;
  setEnabled(on: boolean): Promise<void>;
  wipeLocalData(): Promise<void>;
}

/** Request-log reader for developer mode (E). Event payload is opaque here. */
export interface RequestLogReader {
  snapshot(): readonly unknown[];
  subscribe(cb: (event: unknown) => void): () => void;
  onClear(cb: () => void): () => void;
}

export interface HostContext {
  client(): PanelClient | undefined;
  onClientChange(cb: () => void): () => void;
  developerMode(): boolean;
  setStatus(source: string, status: StatusCode | null): void;
  /** Status currently shown in the panel header (highest priority), or null. */
  topStatus(): StatusCode | null;
  /** Fires whenever `topStatus()` changes. Returns the unsubscribe function. */
  onStatusChange(cb: () => void): () => void;
  /** False when `ui.toasts` is false. Parts check it before any work that only feeds a toast. */
  toastsEnabled(): boolean;
  /** Returns the toast id, or null when `ui.toasts` is false. */
  toast(t: ToastRequest): string | null;
  /** strings.ts lookup. Unknown codes return the neutral line, never raw text. */
  text(code: string, params?: Readonly<Record<string, string | number>>): string;
  /** App name for the header ("in <app>"). Undefined when the app id is the page fallback. */
  appLabel(): string | undefined;
  /** True when the launcher button exists, so Overview can offer to hide it. */
  canHideButton(): boolean;
  /** Hides the launcher button, persists it, and closes the panel. */
  hideButton(): void;
}

/** Views the shell reads for statuses. `account` is read by Overview itself. */
export interface DataViews {
  readonly localNode: LocalNodeState;
  readonly localCopy: LocalCopyStatus;
  readonly delegations: DelegationPage;
  readonly nodes: readonly NodeRow[];
  readonly storage: StorageView;
  readonly account: AccountInfo;
}

export type DataKey = keyof DataViews;

/**
 * The shell's read cache over `PanelDataSource`. `status(ctx)` is synchronous,
 * so it reads `latest` instead of awaiting the source. The shell fills the
 * cache when the panel opens, on every source change, and each minute while open.
 */
export interface SectionData {
  /** The client's data source. Undefined when the host gave none. */
  readonly source: PanelDataSource | undefined;
  /** Last result the shell read for `key`; undefined until the first read settles. Never waits. */
  latest<K extends Exclude<DataKey, "account">>(key: K): ViewResult<DataViews[K]> | undefined;
  /**
   * Account generation: a number that changes on every reset (sign-out, account switch, client change).
   * Capture it before any await whose result is keyed by account and discard the result if it changed.
   */
  generation(): number;
  /** Milliseconds since `latest(key)` settled; undefined when it never has. */
  age(key: Exclude<DataKey, "account">): number | undefined;
  /** Re-reads one view, or all of them. Resolves once the cache holds the new results. */
  refresh(key?: Exclude<DataKey, "account">): Promise<void>;
  /** Calls `listener` after any cached result changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Visible state of a one-line status. `info` is neutral: checking, needs permission, unavailable. */
export type StatusTone = "ok" | "warn" | "off" | "info";

/**
 * What a section says about itself in the At-a-glance rows and on the page rail.
 * The rail shows `count ?? text`; the glance row shows `text` with its tone dot.
 */
export interface SectionStatus {
  readonly text: string;
  readonly tone: StatusTone;
  readonly count?: string;
}

export interface ConfirmRequest {
  readonly question: string;
  /** The safe action. It takes focus, and Enter and Escape take it. */
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  /** The box is inserted after this element. Default: the end of the section. */
  readonly anchor?: HTMLElement;
  /** Runs after the safe action or Escape. The box is already closed. */
  readonly onCancel?: () => void;
  /** Runs on the destructive action. The box stays until `close()`. */
  readonly onConfirm: () => void;
}

export interface ConfirmHandle {
  readonly cancel: HTMLButtonElement;
  readonly confirm: HTMLButtonElement;
  close(): void;
}

export interface DrawerRequest {
  readonly title: string;
  readonly body: readonly Node[];
  readonly closeLabel: string;
  /** The drawer is inserted after this element. Default: the end of the section. */
  readonly anchor?: HTMLElement;
  /** Runs after the drawer closes. */
  readonly onClose?: () => void;
}

export interface DrawerHandle {
  readonly el: HTMLElement;
  close(): void;
}

/** Context the panel shell gives sections. Only the lazy shell builds it. */
export interface SectionContext extends HostContext {
  /** Closes the panel. Focus returns to the launcher when the shell owned it. */
  closePanel(): void;
  /** Opens a section in the panel. Used by At-a-glance rows. */
  openSection(id: SectionId): void;
  /** Shows a receipt slip (title, identifiers, Copy receipt). False when toasts are off or the same receipt is already up. */
  receipt(request: ReceiptRequest): boolean;
  /** Read cache over the client's data source. */
  readonly data: SectionData;
  /** Layout the panel is in now. Read at mount; the shell remounts the section when it changes. */
  layout(): ShellLayout;
  /** Sections the panel offers right now, in nav order, Overview included. */
  sections(): readonly PanelSection[];
  /** Repaints statuses (page rail, At a glance) after a change the data source did not announce. Does not remount the section. */
  requestRender(): void;
  /** Inline confirm for a destructive action; the safe action takes focus. */
  confirm(request: ConfirmRequest): ConfirmHandle;
  /** Inline details drawer. */
  openDrawer(request: DrawerRequest): DrawerHandle;
}

/** A body section in the panel. Mounted only while the panel is open and `isAvailable`. */
export interface PanelSection {
  readonly id: SectionId;
  /** strings.ts key for the title: the nav label and the rail text. */
  readonly labelCode: StringKey;
  /** Icon on the full-page rail and the At-a-glance row. */
  readonly icon: IconName;
  /** Panel string code for the one-line description under the title on Overview. Undefined: no row for this section. */
  readonly summaryCode?: string;
  isAvailable(ctx: HostContext): boolean;
  /** Synchronous read of what the section knows from `ctx.data`. Undefined shows nothing. */
  status(ctx: SectionContext): SectionStatus | undefined;
  /** Renders the body into `el`. Returns dispose. May touch only `el`. */
  mount(el: HTMLElement, ctx: SectionContext): () => void;
}

/** Always-on part. Runs while the client is registered, even with the panel closed and button hidden. */
export interface HostPart {
  readonly id: "toasts" | "prompts" | "storage-watch" | "sync-status";
  /** Returns stop. */
  start(ctx: HostContext, layer: HTMLElement): () => void;
}

/** Authority kinds a client can be asked for. The bridge is internal; views without it show a neutral line. */
export type AuthorityKind = "kv/sync" | "space/info" | "delegation/list" | "space/list";

/**
 * Outcome of `purgeLocalCopy`. `retryNow` is true when the replica keys may still be in the database
 * (deny outcome marker or unguarded), so the copy may still be readable and one immediate retry is worthwhile.
 */
export type PurgeLocalCopyResult = { readonly ok: true } | { readonly ok: false; readonly retryNow: boolean };

/** Narrow adapter built by ui/client.ts from TinyCloudWeb. */
export interface PanelClient {
  readonly id: number;
  signedIn(): boolean;
  /** Sign-out or account switch. */
  onReset(cb: () => void): () => void;
  /** = tc.sync when present. */
  readonly sync?: SyncFacade | undefined;
  readonly storage: Pick<IStorageService, "status">;
  /** Storage episode view. Undefined when the client does not expose it. `subscribeDelegated` fires once per delegated owner found full. */
  readonly storageEpisode?:
    | {
        current(): unknown;
        subscribe(cb: () => void): () => void;
        subscribeDelegated(cb: () => void): () => void;
      }
    | undefined;
  /**
   * Asks for the read-only permission a tab is missing. Defined only when the page can show the SDK's permission prompt
   * (a page signer and a manifest exist); undefined otherwise. Resolves `{ approved: false, code: "declined" }` when
   * the user declines or closes the prompt and `code: "failed"` when the request errors. One request at a time:
   * a second call while one is open returns the open one.
   */
  readonly requestAuthority?:
    | ((kind: AuthorityKind) => Promise<{ approved: boolean; code?: FacadeErrorCode }>)
    | undefined;
  /** False when `requestAuthority` has no entry for `kind`, so a tab has no button for it. Absent: unknown. */
  readonly canRequest?: ((kind: AuthorityKind) => boolean) | undefined;
  /** Where the app runs (`ui.platform`). Absent: web. */
  readonly platform?: UiPlatform | undefined;
  /** E: request log, present only in developer mode. */
  readonly requests?: RequestLogReader | undefined;
  /** Panel data for the views. Undefined unless the host supplied a data factory (harness or preview); production panels show placeholders. */
  readonly data?: PanelDataSource | undefined;
  /** Signs out of the TinyCloud session. Undefined when the host cannot sign out; Overview then omits the control. */
  readonly signOut?: (() => Promise<void>) | undefined;
  /**
   * Removes the local copy from this browser after sign-out. Supplied by the host app or the SDK; the panel
   * only calls it, after `signOut` has settled. Undefined: nothing to purge.
   */
  readonly purgeLocalCopy?: (() => Promise<PurgeLocalCopyResult>) | undefined;
}
