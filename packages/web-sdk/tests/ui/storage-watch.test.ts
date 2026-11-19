import { describe, expect, test } from "bun:test";
import { STORAGE_MANAGE_URL } from "@tinycloud/sdk-core";

import { storageWatch } from "../../src/ui/parts/storage-watch";
import type { HostContext, PanelClient, StatusCode } from "../../src/ui/slots";
import type { ToastRequest } from "../../src/ui/toast-store";
import { text } from "../../src/ui/strings";

interface EpisodeStub {
  readonly view: {
    current(): unknown;
    subscribe(cb: () => void): () => void;
    subscribeDelegated(cb: () => void): () => void;
  };
  set(on: boolean): void;
  /** Fires the delegated-owner notification, as the SDK does once per owner until cleared. */
  delegated(): void;
  listenerCount(): number;
  delegatedListenerCount(): number;
}

type StatusRead = () => Promise<unknown>;

/** A failed status read: the toast falls back to the constant manage link. */
const failedStatus: StatusRead = () => Promise.resolve({ error: { code: "NETWORK_ERROR" } });

/** Lets the status read and the toast it gates run to completion. Microtasks only, no timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function makeEpisode(initiallyOn: boolean): EpisodeStub {
  let on = initiallyOn;
  const listeners = new Set<() => void>();
  const delegatedListeners = new Set<() => void>();
  return {
    view: {
      current: () => (on ? { since: 1 } : undefined),
      subscribe(cb) {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      subscribeDelegated(cb) {
        delegatedListeners.add(cb);
        return () => {
          delegatedListeners.delete(cb);
        };
      },
    },
    set(next) {
      on = next;
      for (const cb of [...listeners]) cb();
    },
    delegated() {
      for (const cb of [...delegatedListeners]) cb();
    },
    listenerCount: () => listeners.size,
    delegatedListenerCount: () => delegatedListeners.size,
  };
}

function makeHost(initial: EpisodeStub | undefined, status: StatusRead = failedStatus, toastsOn = true) {
  let episode = initial;
  const clientListeners = new Set<() => void>();
  const statuses: Array<StatusCode | null> = [];
  const toasts: ToastRequest[] = [];
  const ctx: HostContext = {
    client: () =>
      ({ storageEpisode: episode?.view, storage: { status } }) as unknown as PanelClient,
    onClientChange: (cb) => {
      clientListeners.add(cb);
      return () => {
        clientListeners.delete(cb);
      };
    },
    developerMode: () => false,
    toastsEnabled: () => toastsOn,
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
  test("an episode that is already on publishes storage_full and one toast with the manage link", async () => {
    const host = makeHost(makeEpisode(true));
    storageWatch.start(host.ctx, layer);
    await settle();

    expect(host.statuses).toEqual(["storage_full"]);
    expect(host.toasts).toEqual([
      {
        kind: "info",
        textCode: "storage.full",
        href: STORAGE_MANAGE_URL,
        hrefLabelCode: "storage.manage",
      },
    ]);
  });

  test("an episode that is off publishes nothing and shows no toast", async () => {
    const host = makeHost(makeEpisode(false));
    storageWatch.start(host.ctx, layer);
    await settle();

    expect(host.statuses).toEqual([null]);
    expect(host.toasts).toEqual([]);
  });

  test("repeated episode notifications while on toast once", async () => {
    const episode = makeEpisode(false);
    const host = makeHost(episode);
    storageWatch.start(host.ctx, layer);

    episode.set(true);
    episode.set(true);
    episode.set(true);
    await settle();

    expect(host.toasts).toHaveLength(1);
  });

  test("a new episode after the previous one ended toasts again", async () => {
    const episode = makeEpisode(true);
    const host = makeHost(episode);
    storageWatch.start(host.ctx, layer);

    await settle();
    episode.set(false);
    await settle();
    episode.set(true);
    await settle();

    expect(host.toasts).toHaveLength(2);
    expect(host.statuses).toEqual(["storage_full", null, "storage_full"]);
  });

  test("the toast links the status manageUrl when it is https", async () => {
    const host = makeHost(makeEpisode(true), () =>
      Promise.resolve({ data: { manageUrl: "https://account.example.test/plans" } }),
    );
    storageWatch.start(host.ctx, layer);
    await settle();

    expect(host.toasts.map((toast) => toast.href)).toEqual(["https://account.example.test/plans"]);
  });

  test("a non-https manageUrl falls back to the constant manage link", async () => {
    const host = makeHost(makeEpisode(true), () =>
      Promise.resolve({ data: { manageUrl: "http://insecure.example.test/plans" } }),
    );
    storageWatch.start(host.ctx, layer);
    await settle();

    expect(host.toasts.map((toast) => toast.href)).toEqual([STORAGE_MANAGE_URL]);
  });

  test("a status read that rejects still toasts once with the constant manage link", async () => {
    const host = makeHost(makeEpisode(true), () => Promise.reject(new Error("offline")));
    storageWatch.start(host.ctx, layer);
    await settle();

    expect(host.toasts.map((toast) => toast.href)).toEqual([STORAGE_MANAGE_URL]);
  });

  test("a status read that finishes after the episode ended does not toast for it", async () => {
    const pending = Promise.withResolvers<unknown>();
    const episode = makeEpisode(true);
    const host = makeHost(episode, () => pending.promise);
    storageWatch.start(host.ctx, layer);

    episode.set(false);
    pending.resolve({ data: { manageUrl: "https://account.example.test/plans" } });
    await settle();
    expect(host.toasts).toEqual([]);

    episode.set(true);
    await settle();
    expect(host.toasts).toHaveLength(1);
  });

  test("ending the episode clears the status", () => {
    const episode = makeEpisode(true);
    const host = makeHost(episode);
    storageWatch.start(host.ctx, layer);

    episode.set(false);

    expect(host.statuses.at(-1)).toBeNull();
  });

  test("switching to a client with no episode clears the status and keeps the toast quiet", async () => {
    const host = makeHost(makeEpisode(true));
    storageWatch.start(host.ctx, layer);
    await settle();

    host.swap(undefined);
    await settle();

    expect(host.statuses.at(-1)).toBeNull();
    expect(host.toasts).toHaveLength(1);
  });

  test("switching to a new client whose episode is on announces it", async () => {
    const host = makeHost(undefined);
    storageWatch.start(host.ctx, layer);

    host.swap(makeEpisode(true));
    await settle();

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
    expect(episode.delegatedListenerCount()).toBe(0);
  });

  test("a delegated owner found full shows an info toast and sets no own status", async () => {
    const episode = makeEpisode(false);
    const host = makeHost(episode);
    storageWatch.start(host.ctx, layer);

    episode.delegated();
    await settle();

    expect(host.toasts).toHaveLength(1);
    expect(host.toasts[0]).toMatchObject({
      kind: "info",
      textCode: "storage.full",
      href: STORAGE_MANAGE_URL,
    });
    expect(host.statuses).not.toContain("storage_full");
  });

  test("with ui.toasts off, a full episode shows the status and makes no status request", async () => {
    let reads = 0;
    const episode = makeEpisode(true);
    const host = makeHost(
      episode,
      () => {
        reads += 1;
        return failedStatus();
      },
      false,
    );
    storageWatch.start(host.ctx, layer);
    await settle();

    expect(host.statuses).toEqual(["storage_full"]);
    expect(reads).toBe(0);
    expect(host.toasts).toHaveLength(0);
  });

  test("with ui.toasts off, a delegated owner found full makes no status request", async () => {
    let reads = 0;
    const episode = makeEpisode(false);
    const host = makeHost(
      episode,
      () => {
        reads += 1;
        return failedStatus();
      },
      false,
    );
    storageWatch.start(host.ctx, layer);

    episode.delegated();
    await settle();

    expect(reads).toBe(0);
    expect(host.toasts).toHaveLength(0);
  });

  test("a delegated toast whose status read finishes after a client switch is dropped", async () => {
    const pending = Promise.withResolvers<unknown>();
    const episode = makeEpisode(false);
    const host = makeHost(episode, () => pending.promise);
    storageWatch.start(host.ctx, layer);

    episode.delegated();
    host.swap(undefined);
    pending.resolve({ data: { manageUrl: "https://example.test/manage" } });
    await settle();

    expect(host.toasts).toHaveLength(0);
  });
});
