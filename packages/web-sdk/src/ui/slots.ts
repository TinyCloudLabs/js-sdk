/**
 * Internal view-slot interface. The only contract the panel sections and
 * always-on parts code against. Panel code never sees TinyCloudWeb.
 */

import type { IStorageService } from "@tinycloud/sdk-core";
import type { StringKey } from "./strings";
import type { PanelDataSource } from "./data";
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
  text(code: string): string;
  /** App name for the header ("in <app>"). Undefined when the app id is the page fallback. */
  appLabel(): string | undefined;
  /** True when the launcher button exists, so Overview can offer to hide it. */
  canHideButton(): boolean;
  /** Hides the launcher button, persists it, and closes the panel. */
  hideButton(): void;
}

/** Context the panel shell gives sections. Only the lazy shell builds it. */
export interface SectionContext extends HostContext {
  /** Closes the panel. Focus returns to the launcher when the shell owned it. */
  closePanel(): void;
  /** Opens a section in the panel. Used by At-a-glance rows. */
  openSection(id: SectionId): void;
}

/** A body section in the panel. Mounted only while the panel is open and `isAvailable`. */
export interface PanelSection {
  readonly id: SectionId;
  /** strings.ts key for the nav label. */
  readonly labelCode: StringKey;
  isAvailable(ctx: HostContext): boolean;
  /** Returns dispose. May touch only `el`. */
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
  /** Authority request for storage and sync prompts. Undefined when the client does not expose it. */
  readonly requestAuthority?:
    | ((kind: AuthorityKind) => Promise<{ approved: boolean; code?: FacadeErrorCode }>)
    | undefined;
  /** E: request log, present only in developer mode. */
  readonly requests?: RequestLogReader | undefined;
  /** Panel data for the views. Undefined unless the host supplied a data factory (harness or preview); production panels show placeholders. */
  readonly data?: PanelDataSource | undefined;
  /** Signs out of the TinyCloud session. Undefined when the host cannot sign out; Overview then omits the control. */
  readonly signOut?: (() => Promise<void>) | undefined;
}
