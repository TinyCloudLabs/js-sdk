import { describe, expect, test } from "bun:test";
import { STORAGE_MANAGE_URL } from "@tinycloud/sdk-core";

import { storageWatch } from "../../src/ui/parts/storage-watch";
import type { HostContext, PanelClient, StatusCode } from "../../src/ui/slots";
import type { ToastRequest } from "../../src/ui/toast-store";
import { text } from "../../src/ui/strings";

interface EpisodeStub {
  readonly view: { current(): unknown; subscribe(cb: () => void): () => void };
  set(on: boolean): void;
  listenerCount(): number;
}

function makeEpisode(initiallyOn: boolean): EpisodeStub {
  let on = initiallyOn;
  const listeners = new Set<() => void>();
  return {
    view: {
      current: () => (on ? { since: 1 } : undefined),
      subscribe(cb) {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
    set(next) {
      on = next;
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.size,
  };
}

function makeHost(initial: EpisodeStub | undefined) {
  let episode = initial;
  const clientListeners = new Set<() => void>();
  const statuses: Array<StatusCode | null> = [];
  const toasts: ToastRequest[] = [];
  const ctx: HostContext = {
    client: () => ({ storageEpisode: episode?.view }) as unknown as PanelClient,
    onClientChange: (cb) => {
      clientListeners.add(cb);
      return () => {
        clientListeners.delete(cb);
      };
    },
    developerMode: () => false,
    setStatus: (source, status) => {
      if (source === "storage") statuses.push(status);
    },
    toast: (request) => {
      toasts.push(request);
      return "";
    },
    openPanel: () => undefined,
    closePanel: () => undefined,
    text,
  };
  return {
    ctx,
    statuses,
    toasts,
    clientListenerCount: () => clientListeners.size,
    swap(next: EpisodeStub | undefined) {
      episode = next;
      for (const cb of [...clientListeners]) cb();
    },
  };
}

const layer = {} as HTMLElement;

describe("storage-watch part", () => {
  test("an episode that is already on publishes storage_full and one toast with the manage link", () => {
    const host = makeHost(makeEpisode(true));
    storageWatch.start(host.ctx, layer);

    expect(host.statuses).toEqual(["storage_full"]);
    expect(host.toasts).toEqual([
      {
        kind: "warning",
        textCode: "storage.full",
        href: STORAGE_MANAGE_URL,
        hrefLabelCode: "storage.manage",
      },
    ]);
  });

  test("an episode that is off publishes nothing and shows no toast", () => {
    const host = makeHost(makeEpisode(false));
    storageWatch.start(host.ctx, layer);

    expect(host.statuses).toEqual([null]);
    expect(host.toasts).toEqual([]);
  });

  test("repeated episode notifications while on toast once", () => {
    const episode = makeEpisode(false);
    const host = makeHost(episode);
    storageWatch.start(host.ctx, layer);

    episode.set(true);
    episode.set(true);
    episode.set(true);

    expect(host.toasts).toHaveLength(1);
  });

  test("a new episode after the previous one ended toasts again", () => {
    const episode = makeEpisode(true);
    const host = makeHost(episode);
    storageWatch.start(host.ctx, layer);

    episode.set(false);
    episode.set(true);

    expect(host.toasts).toHaveLength(2);
    expect(host.statuses).toEqual(["storage_full", null, "storage_full"]);
  });

  test("ending the episode clears the status", () => {
    const episode = makeEpisode(true);
    const host = makeHost(episode);
    storageWatch.start(host.ctx, layer);

    episode.set(false);

    expect(host.statuses.at(-1)).toBeNull();
  });

  test("switching to a client with no episode clears the status and keeps the toast quiet", () => {
    const host = makeHost(makeEpisode(true));
    storageWatch.start(host.ctx, layer);

    host.swap(undefined);

    expect(host.statuses.at(-1)).toBeNull();
    expect(host.toasts).toHaveLength(1);
  });

  test("switching to a new client whose episode is on announces it", () => {
    const host = makeHost(undefined);
    storageWatch.start(host.ctx, layer);

    host.swap(makeEpisode(true));

    expect(host.statuses.at(-1)).toBe("storage_full");
    expect(host.toasts).toHaveLength(1);
  });

  test("stop unsubscribes from the episode and clears the status", () => {
    const episode = makeEpisode(true);
    const host = makeHost(episode);
    const stop = storageWatch.start(host.ctx, layer);

    stop();
    episode.set(false);

    expect(episode.listenerCount()).toBe(0);
    expect(host.statuses.at(-1)).toBeNull();
    expect(host.clientListenerCount()).toBe(0);
  });
});
