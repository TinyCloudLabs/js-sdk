/*
 * Lazy panel-data entry. panel-data-loader.ts loads it on the first panel read, or
 * on sign-in/restore and intent to arm and start the background prefetch. The live
 * adapter, its schema mapping, and the prefetch state stay out of the eager root
 * (12 KiB gzip budget, contracts-ade §1.4). The root reaches it only through dynamic import().
 */
export { createRealPanelData } from "./data/real";
import { browserIdle, createPanelPrefetch, type PanelPrefetch } from "./data/prefetch";
import type { PanelClient } from "./slots";

const prefetches = new WeakMap<PanelClient, PanelPrefetch>();

/** Sign-in or restore: starts the background pull once per session. A reset re-arms. */
export function armPanelPrefetch(client: PanelClient, registrySettled: () => Promise<void>): void {
  const data = client.data;
  if (prefetches.has(client) || !data || !client.signedIn()) return;
  prefetches.set(
    client,
    createPanelPrefetch({ data, registrySettled, idle: browserIdle, onReset: (cb) => client.onReset(cb) }),
  );
  client.onReset(() => prefetches.delete(client));
}

/** Panel open or launcher hover/focus: starts an armed pull now, skipping the idle gate. */
export function intentPanelPrefetch(client: PanelClient | undefined): void {
  if (client) prefetches.get(client)?.intent();
}
