/*
 * Eager side of the panel data layer. The production data factory returns a
 * source that loads the real adapter (panel-data.mjs / .cjs) on its first read.
 * The adapter stays out of the eager root; this module is the only one that
 * reaches panel-data-entry, through a dynamic import() that webpack externalizes.
 */
import type { PanelDataFactory, PanelDataHost, PanelDataSource } from "./data";
import type { PanelClient } from "./slots";

/** Code-split point. The adapter must stay out of the eager root, so a static import cannot be used here. */
const loadEntry = () => import("./panel-data-entry");

/** Production panel data: a lazy source over the real adapter. */
export function lazyRealPanelData(host: PanelDataHost, appName: () => string): PanelDataFactory {
  return (client) => {
    let source: Promise<PanelDataSource> | undefined;
    // A failed chunk load clears the memo, so the next read retries the import.
    const ready = (): Promise<PanelDataSource> => {
      source ??= loadEntry()
        .then((entry) => entry.createRealPanelData(host, client, appName()))
        .catch((error: unknown) => {
          source = undefined;
          throw error;
        });
      return source;
    };

    return {
      subscribe(listener) {
        let off: (() => void) | undefined;
        let closed = false;
        ready().then(
          (real) => {
            if (!closed) off = real.subscribe(listener);
          },
          () => undefined,
        );
        return () => {
          closed = true;
          off?.();
        };
      },
      account: async () => (await ready()).account(),
      localNode: async () => (await ready()).localNode(),
      setLocalNodeEnabled: async (on) => (await ready()).setLocalNodeEnabled(on),
      localCopy: async () => (await ready()).localCopy(),
      delegations: async (cursor) => (await ready()).delegations(cursor),
      revoke: async (cid) => (await ready()).revoke(cid),
      nodes: async () => (await ready()).nodes(),
      storage: async (options) => (await ready()).storage(options),
    };
  };
}

/** Sign-in or restore: arms the background pull. The state lives in the lazy entry; this wrapper is the only eager cost. */
export function armPanelPrefetch(client: PanelClient, registrySettled: () => Promise<void>): void {
  void loadEntry().then((entry) => entry.armPanelPrefetch(client, registrySettled), () => undefined);
}

/** Panel open or launcher hover/focus: starts an armed pull now, skipping the idle gate. */
export function intentPanelPrefetch(client: PanelClient | undefined): void {
  if (client) void loadEntry().then((entry) => entry.intentPanelPrefetch(client), () => undefined);
}
