/*
 * Background pull of the panel's three reads, so the panel can open from memory.
 * Lazy: only the panel-data bundle imports this module.
 *
 * Start: once the browser is idle (3 s cap) AND the account registry sync has settled.
 * An intent (panel open, launcher hover or focus) starts the pull at once.
 * Reset (sign-out) before the start cancels it. A read already in flight finishes
 * into the old data object, which the client drops on reset.
 */
import type { PanelDataSource } from "../data";

export interface PanelPrefetch {
  /** Panel open or launcher hover/focus: start now, skipping the idle gate. No-op after the first start. */
  intent(): void;
}

export interface PrefetchDeps {
  readonly data: PanelDataSource;
  /** Resolves when the account registry sync has settled. */
  readonly registrySettled: () => Promise<void>;
  /** Resolves on browser idle or after the cap. */
  readonly idle: () => Promise<void>;
  readonly onReset: (cb: () => void) => () => void;
}

/** Starts one pull per prefetch. A failed read does not stop the others and is not retried. */
export function createPanelPrefetch(deps: PrefetchDeps): PanelPrefetch {
  let phase: "waiting" | "pulling" | "done" | "reset" = "waiting";

  const start = (): void => {
    if (phase !== "waiting") return;
    phase = "pulling";
    void Promise.allSettled([deps.data.account(), deps.data.delegations(), deps.data.storage()]).then(() => {
      if (phase === "pulling") phase = "done";
    });
  };

  // `.then(start, start)`: a gate that rejects must not block the prefetch.
  void Promise.all([deps.idle(), deps.registrySettled()]).then(start, start);

  const off = deps.onReset(() => {
    phase = "reset";
    off();
  });

  return { intent: start };
}

/** Browser idle, capped at 3 s; setTimeout 2 s where requestIdleCallback is missing. Never rejects. */
export function browserIdle(): Promise<void> {
  return new Promise((resolve) => {
    if ("requestIdleCallback" in globalThis) {
      globalThis.requestIdleCallback(() => resolve(), { timeout: 3000 });
    } else {
      setTimeout(resolve, 2000);
    }
  });
}
