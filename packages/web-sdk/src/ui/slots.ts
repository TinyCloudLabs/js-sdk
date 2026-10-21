/**
 * Internal view-slot interface. The only contract the panel sections and
 * always-on parts code against. Panel code never sees TinyCloudWeb.
 */

import type { IStorageService } from "@tinycloud/sdk-core";

export type SectionId = "sync" | "storage" | "developer";

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
  toast(t: {
    kind: "info" | "success" | "warning" | "error";
    textCode: string;
    href?: string;
    hrefLabelCode?: string;
  }): string;
  openPanel(): void;
  closePanel(): void;
  /** strings.ts lookup. Unknown codes return the neutral line, never raw text. */
  text(code: string): string;
}

/** A body section in the panel. Mounted only while the panel is open and `isAvailable`. */
export interface PanelSection {
  readonly id: SectionId;
  isAvailable(ctx: HostContext): boolean;
  /** Returns dispose. May touch only `el`. */
  mount(el: HTMLElement, ctx: HostContext): () => void;
}

/** Always-on part. Runs while the client is registered, even with the panel closed and button hidden. */
export interface HostPart {
  readonly id: "toasts" | "prompts" | "storage-watch" | "sync-status";
  /** Returns stop. */
  start(ctx: HostContext, layer: HTMLElement): () => void;
}

/** Narrow adapter built by ui/client.ts from TinyCloudWeb. */
export interface PanelClient {
  readonly id: number;
  signedIn(): boolean;
  /** Sign-out or account switch. */
  onReset(cb: () => void): () => void;
  /** = tc.sync when present. */
  readonly sync?: SyncFacade | undefined;
  readonly storage: Pick<IStorageService, "status">;
  /** D3: storage episode view. Undefined until D3 lands. */
  readonly storageEpisode?: { current(): unknown; subscribe(cb: () => void): () => void } | undefined;
  /** B2: internal authority request for replication. Undefined until B2 lands. */
  readonly requestAuthority?:
    | ((kind: "kv/sync" | "space/info") => Promise<{ approved: boolean; code?: FacadeErrorCode }>)
    | undefined;
  /** E: request log, present only in developer mode. */
  readonly requests?: RequestLogReader | undefined;
}
