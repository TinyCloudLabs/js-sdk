/*
 * Lazy panel-data entry. Loaded by dynamic import() from two eager sites: sign-in or
 * restore (index.ts armPrefetch) and launcher hover, focus or open (host.ts). Every
 * gate lives here: signed-in check, browser idle (3 s cap), account registry sync,
 * idempotence per client, and cancellation on reset. The panel (panel-entry.ts) reads
 * the same module, so the background prefetch and the open panel share one live source
 * per client. The adapter, schema mapping and prefetch state stay out of the eager root
 * (12 KiB gzip budget, contracts-ade §1.4).
 */
import type { PanelDataHost, PanelDataSource } from "./data";
import { browserIdle, createPanelPrefetch, type PanelPrefetch } from "./data/prefetch";
import { createRealPanelData } from "./data/real";
import type { PanelClient } from "./slots";

/** The part of ClientSource the prefetch gates on. */
export interface RegistryGate {
  waitForAccountRegistrySync?(): Promise<void>;
}

export interface ArmOptions {
  /** Sign-in or restore: the app host the real adapter reads from. */
  readonly host?: PanelDataHost;
  /** Sign-in or restore: the source whose account registry sync gates the pull. */
  readonly gate?: RegistryGate;
  /** Sign-in or restore: the app name shown in the account view. */
  readonly appName?: () => string | undefined;
  /** Launcher hover, focus or open: start an armed pull now, skipping the idle gate. */
  readonly now?: boolean;
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
 * Sign-in or restore (`host` and `gate` set): builds this client's live source once and
 * arms the pull behind the idle and registry gates. Launcher intent (`now`): starts an
 * armed pull at once; a no-op before arm. A reset drops the source, so the next sign-in
 * builds a fresh one.
 */
export function arm(client: PanelClient, opts: ArmOptions = {}): void {
  const existing = live.get(client);
  if (existing) {
    if (opts.now) existing.prefetch.intent();
    return;
  }
  const { host, gate } = opts;
  if (!host || !gate || !client.signedIn()) return;
  const source = client.data ?? createRealPanelData(host, client, opts.appName?.() ?? "");
  const prefetch = createPanelPrefetch({
    data: source,
    registrySettled: () => gate.waitForAccountRegistrySync?.() ?? Promise.resolve(),
    idle: browserIdle,
    onReset: (cb) => client.onReset(cb),
  });
  live.set(client, { source, prefetch });
  client.onReset(() => {
    live.delete(client);
    notify(client);
  });
  notify(client);
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
