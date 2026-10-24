/*
 * Lazy panel-data entry. The eager root loads it by dynamic import() on sign-in or
 * restore (index.ts armPrefetch) and on launcher hover/focus (host.ts). The lazy panel
 * (panel-entry.ts) reads the same module, so the background prefetch and the open panel
 * share one live source per client. The adapter, its schema mapping and the prefetch
 * state stay out of the eager root (12 KiB gzip budget, contracts-ade §1.4).
 */
import type { PanelDataHost, PanelDataSource } from "./data";
import { createPanelPrefetch, type PanelPrefetch } from "./data/prefetch";
import { createRealPanelData } from "./data/real";
import type { PanelClient } from "./slots";

/** The part of ClientSource the prefetch gates on. */
export interface RegistryGate {
  waitForAccountRegistrySync?(): Promise<void>;
}

interface Live {
  readonly source: PanelDataSource;
  readonly prefetch: PanelPrefetch;
}

const live = new WeakMap<PanelClient, Live>();
const changes = new WeakMap<PanelClient, Set<() => void>>();

function notify(client: PanelClient): void {
  for (const cb of [...(changes.get(client) ?? [])]) cb();
}

/**
 * Sign-in or restore: builds this client's live source once and starts the pull.
 * A reset drops the source, so the next sign-in builds a fresh one.
 */
export function armPanelPrefetch(
  client: PanelClient,
  host: PanelDataHost,
  gate: RegistryGate,
  appName: () => string,
): void {
  if (live.has(client) || !client.signedIn()) return;
  const source = client.data ?? createRealPanelData(host, client, appName());
  const prefetch = createPanelPrefetch({
    data: source,
    registrySettled: () => gate.waitForAccountRegistrySync?.() ?? Promise.resolve(),
    // The eager root already waited for idle before loading this entry.
    idle: () => Promise.resolve(),
    onReset: (cb) => client.onReset(cb),
  });
  live.set(client, { source, prefetch });
  client.onReset(() => {
    live.delete(client);
    notify(client);
  });
  notify(client);
}

/** Panel open or launcher hover/focus: starts an armed pull now, skipping the idle gate. */
export function intentPanelPrefetch(client: PanelClient | undefined): void {
  if (client) live.get(client)?.prefetch.intent();
}

/** The live source for this client, or undefined before arm and after reset. */
export function livePanelData(client: PanelClient): PanelDataSource | undefined {
  return live.get(client)?.source;
}

/** Calls `cb` whenever the live source is armed or dropped. Returns unsubscribe. */
export function onLivePanelDataChange(client: PanelClient, cb: () => void): () => void {
  let set = changes.get(client);
  if (set === undefined) {
    set = new Set();
    changes.set(client, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}
