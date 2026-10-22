import { STORAGE_MANAGE_URL } from "../manage-url";
import type { HostPart, PanelClient } from "../slots";
import { manageHrefFor } from "../storage-state";

/** Board source. Only this part publishes the storage episode status. */
const SOURCE = "storage";

type Episode = NonNullable<PanelClient["storageEpisode"]>;

/**
 * Always-on storage warnings for the active client. While the own-storage episode is on, publishes
 * storage_full and shows one info toast per episode. A delegated owner found full shows one info
 * toast per SDK notification (the SDK emits once per owner until that owner is cleared). Every toast
 * links to the manage page: the status `manageUrl` when it is https, read at toast time, and the
 * constant otherwise. The own toast is shown again only after the episode ends and starts again.
 * Re-points on client change.
 */
export const storageWatch: HostPart = {
  id: "storage-watch",
  start(ctx) {
    let episode: Episode | undefined;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeDelegated: (() => void) | undefined;
    let announced = false;
    // Bumped when the own episode changes, so a status read that finishes late cannot toast for a stale episode.
    let epoch = 0;
    // Bumped when the client changes, so a toast from the previous client is dropped.
    let clientGen = 0;

    async function manageLink(client: PanelClient | undefined): Promise<string> {
      if (client === undefined) return STORAGE_MANAGE_URL;
      try {
        const result = await client.storage.status();
        return "error" in result ? STORAGE_MANAGE_URL : manageHrefFor(result.data);
      } catch {
        return STORAGE_MANAGE_URL;
      }
    }

    function showFullToast(href: string): void {
      ctx.toast({
        kind: "info",
        textCode: "storage.full",
        href,
        hrefLabelCode: "storage.manage",
      });
    }

    function publish(): void {
      const on = episode !== undefined && episode.current() !== undefined;
      if (!on) {
        announced = false;
        epoch += 1;
        ctx.setStatus(SOURCE, null);
        return;
      }
      ctx.setStatus(SOURCE, "storage_full");
      if (announced || !ctx.toastsEnabled()) return;
      announced = true;
      const mine = epoch;
      void manageLink(ctx.client()).then((href) => {
        if (mine !== epoch) return;
        showFullToast(href);
      });
    }

    function onDelegated(): void {
      if (!ctx.toastsEnabled()) return;
      const gen = clientGen;
      void manageLink(ctx.client()).then((href) => {
        if (gen !== clientGen) return;
        showFullToast(href);
      });
    }

    function attach(): void {
      const next = ctx.client()?.storageEpisode;
      if (next === episode) return;
      unsubscribe?.();
      unsubscribeDelegated?.();
      episode = next;
      clientGen += 1;
      announced = false;
      epoch += 1;
      unsubscribe = next?.subscribe(publish);
      unsubscribeDelegated = next?.subscribeDelegated(onDelegated);
      publish();
    }

    const stopClientWatch = ctx.onClientChange(attach);
    attach();

    return () => {
      stopClientWatch();
      unsubscribe?.();
      unsubscribeDelegated?.();
      epoch += 1;
      clientGen += 1;
      ctx.setStatus(SOURCE, null);
    };
  },
};
