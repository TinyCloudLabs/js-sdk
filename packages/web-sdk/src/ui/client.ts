import type { IStorageService } from "@tinycloud/sdk-core";

import type { PanelClient, SyncFacade } from "./slots";

/**
 * What the UI reads from a TinyCloudWeb instance. The panel never sees
 * TinyCloudWeb itself.
 */
export interface ClientSource {
  signedIn(): boolean;
  readonly sync?: SyncFacade | undefined;
  readonly storage: Pick<IStorageService, "status">;
  readonly storageEpisode?: PanelClient["storageEpisode"];
}

export interface PanelClientHandle {
  readonly client: PanelClient;
  /** Clears this client's per-account view state and fires onReset listeners. */
  reset(): void;
}

export function createPanelClient(id: number, source: ClientSource): PanelClientHandle {
  const resetListeners = new Set<() => void>();

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
    requestAuthority: undefined,
    requests: undefined,
  };

  return {
    client,
    reset() {
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
