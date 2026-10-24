import type { IStorageService } from "@tinycloud/sdk-core";

import type { PanelDataFactory, PanelDataSource } from "./data";
import type { PanelClient, PurgeLocalCopyResult, RequestLogReader, SyncFacade } from "./slots";

/**
 * What the UI reads from a TinyCloudWeb instance. The panel never sees
 * TinyCloudWeb itself.
 */
export interface ClientSource {
  signedIn(): boolean;
  /** Resolves when the account registry sync has settled. Absent means already settled. */
  waitForAccountRegistrySync?(): Promise<void>;
  readonly sync?: SyncFacade | undefined;
  readonly storage: Pick<IStorageService, "status">;
  readonly storageEpisode?: PanelClient["storageEpisode"];
  readonly requests?: RequestLogReader | undefined;
  /** Signs out of the TinyCloud session. Undefined when the host cannot sign out. */
  signOut?: (() => Promise<void>) | undefined;
  /** Removes the local copy from this browser; the panel calls it after sign-out settles. Undefined: nothing to purge. */
  purgeLocalCopy?: (() => Promise<PurgeLocalCopyResult>) | undefined;
}

export interface PanelClientHandle {
  readonly client: PanelClient;
  /** Clears this client's per-account view state and fires onReset listeners. */
  reset(): void;
}

export function createPanelClient(
  id: number,
  source: ClientSource,
  dataFactory?: PanelDataFactory,
): PanelClientHandle {
  const resetListeners = new Set<() => void>();
  // Built on first read and dropped on reset, so a sign-out never keeps the previous account's rows.
  let panelData: PanelDataSource | undefined;

  const client: PanelClient = {
    id,
    signedIn: () => source.signedIn(),
    onReset(cb) {
      resetListeners.add(cb);
      return () => {
        resetListeners.delete(cb);
      };
    },
    get sync() {
      return source.sync;
    },
    get storage() {
      return source.storage;
    },
    get storageEpisode() {
      return source.storageEpisode;
    },
    get data() {
      if (panelData === undefined && dataFactory !== undefined) panelData = dataFactory(client);
      return panelData;
    },
    requestAuthority: undefined,
    requests: source.requests,
    signOut: source.signOut,
    purgeLocalCopy: source.purgeLocalCopy,
  };

  return {
    client,
    reset() {
      panelData = undefined;
      for (const cb of [...resetListeners]) {
        try {
          cb();
        } catch {
          // A failing listener must not block the other resets.
        }
      }
    },
  };
}
