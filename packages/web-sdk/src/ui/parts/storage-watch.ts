import { STORAGE_MANAGE_URL } from "@tinycloud/sdk-core";
import type { HostPart, PanelClient } from "../slots";

/** Board source. Only this part publishes the storage episode status. */
const SOURCE = "storage";

type Episode = NonNullable<PanelClient["storageEpisode"]>;

/**
 * Always-on: while the own-storage episode is on, publishes storage_full and shows one
 * warning toast per episode with the manage link. The toast is shown again only after the
 * episode ends and starts again. Follows the active client's episode and re-points on client change.
 */
export const storageWatch: HostPart = {
  id: "storage-watch",
  start(ctx) {
    let episode: Episode | undefined;
    let unsubscribe: (() => void) | undefined;
    let announced = false;

    function publish(): void {
      const on = episode !== undefined && episode.current() !== undefined;
      if (!on) {
        announced = false;
        ctx.setStatus(SOURCE, null);
        return;
      }
      ctx.setStatus(SOURCE, "storage_full");
      if (announced) return;
      announced = true;
      ctx.toast({
        kind: "warning",
        textCode: "storage.full",
        href: STORAGE_MANAGE_URL,
        hrefLabelCode: "storage.manage",
      });
    }

    function attach(): void {
      const next = ctx.client()?.storageEpisode;
      if (next === episode) return;
      unsubscribe?.();
      episode = next;
      announced = false;
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
