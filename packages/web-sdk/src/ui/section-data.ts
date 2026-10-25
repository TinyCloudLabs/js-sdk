import type { PanelDataSource, ViewResult } from "./data";
import type { DataViews, SectionData } from "./slots";

type CachedKey = Exclude<keyof DataViews, "account">;

const KEYS: readonly CachedKey[] = ["localNode", "localCopy", "delegations", "nodes", "storage"];
const REFRESH_MS = 60_000;

/** The cache the shell owns. `start` and `stop` follow the panel being open. */
export interface SectionDataCache extends SectionData {
  /** Reads every view now, follows source changes, and refreshes each minute until `stop`. */
  start(): void;
  /** Stops following the source and the timer. Cached results stay for the next open. */
  stop(): void;
  /** Drops cached results and rebinds to the new source (account switch or sign-out). */
  reset(): void;
  /** Tells subscribers to repaint without a read (a section changed something the source did not announce). */
  notify(): void;
}

interface Entry {
  readonly result: ViewResult<unknown>;
  readonly at: number;
}

/**
 * Read cache over the client's `PanelDataSource` for synchronous `status(ctx)`.
 * A read that fails is cached as an error result, so a status shows "Unavailable" instead of a stale value.
 * A read that finishes after `reset` or `stop` is dropped.
 */
export function createSectionData(
  getSource: () => PanelDataSource | undefined,
  now: () => number = Date.now,
): SectionDataCache {
  const entries = new Map<CachedKey, Entry>();
  const listeners = new Set<() => void>();
  // Public: changes only when the account does (reset). Sections capture it across awaits.
  let generation = 0;
  // Read guard: also changes on stop, so a read started before the panel closed is dropped too.
  let readEpoch = 0;
  let following = false;
  let unbind: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  async function read(key: CachedKey): Promise<void> {
    const source = getSource();
    if (source === undefined) return;
    const mine = readEpoch;
    let result: ViewResult<unknown>;
    try {
      result = await source[key]();
    } catch {
      result = { state: "error", code: "unknown" };
    }
    if (mine !== readEpoch) return;
    entries.set(key, { result, at: now() });
    emit();
  }

  function refresh(key?: CachedKey): Promise<void> {
    return key === undefined ? Promise.all(KEYS.map(read)).then(() => undefined) : read(key);
  }

  function bind(): void {
    unbind?.();
    unbind = getSource()?.subscribe(() => void refresh());
  }

  return {
    get source() {
      return getSource();
    },
    latest<K extends CachedKey>(key: K): ViewResult<DataViews[K]> | undefined {
      return entries.get(key)?.result as ViewResult<DataViews[K]> | undefined;
    },
    age(key) {
      const entry = entries.get(key);
      return entry === undefined ? undefined : now() - entry.at;
    },
    refresh,
    generation: () => generation,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (following) return;
      following = true;
      bind();
      void refresh();
      timer = setInterval(() => void refresh(), REFRESH_MS);
    },
    stop() {
      following = false;
      readEpoch++;
      unbind?.();
      unbind = undefined;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    reset() {
      generation++;
      readEpoch++;
      entries.clear();
      emit();
      if (!following) return;
      bind();
      void refresh();
    },
    notify: emit,
  };
}
