import type { HostPart, SyncFacade } from "../slots";
import { syncStatus } from "../status";

/** Board source. Only this part publishes sync status, so section mount and unmount never clear it. */
const SOURCE = "sync";

/**
 * Always-on: publishes sync_pending and sync_attention while the client is registered,
 * including while the panel is closed. Follows the active client's facade and re-points on client change.
 */
export const syncStatusPart: HostPart = {
  id: "sync-status",
  start(ctx) {
    let facade: SyncFacade | undefined;
    let unsubscribe: (() => void) | undefined;

    function publish(): void {
      const state = facade?.state;
      ctx.setStatus(SOURCE, state ? syncStatus(state.effective, state.requested) : null);
    }

    function attach(): void {
      const next = ctx.client()?.sync;
      if (next === facade) return;
      unsubscribe?.();
      facade = next;
      unsubscribe = next?.subscribe(publish);
      publish();
    }

    const stopClientWatch = ctx.onClientChange(attach);
    attach();

    return () => {
      stopClientWatch();
      unsubscribe?.();
      ctx.setStatus(SOURCE, null);
    };
  },
};
