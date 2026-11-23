import { describe, expect, test } from "bun:test";

import { syncStatusPart } from "../../src/ui/parts/sync-status";
import type { HostContext, PanelClient, StatusCode, SyncFacade, SyncState } from "../../src/ui/slots";
import { text } from "../../src/ui/strings";

interface FacadeStub extends SyncFacade {
  set(next: SyncState): void;
  listenerCount(): number;
}

function makeFacade(initial: SyncState): FacadeStub {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get state() {
      return state;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setEnabled: async () => undefined,
    wipeLocalData: async () => undefined,
    listenerCount: () => listeners.size,
    set(next) {
      state = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

function makeHost(initial: SyncFacade | undefined) {
  let facade = initial;
  const clientListeners = new Set<() => void>();
  const statuses: Array<StatusCode | null> = [];
  const ctx: HostContext = {
    client: () => ({ sync: facade }) as unknown as PanelClient,
    onClientChange: (cb) => {
      clientListeners.add(cb);
      return () => {
        clientListeners.delete(cb);
      };
    },
    developerMode: () => false,
    setStatus: (source, status) => {
      if (source === "sync") statuses.push(status);
    },
    topStatus: () => null,
    onStatusChange: () => () => undefined,
    toastsEnabled: () => true,
    toast: () => "",
    openPanel: () => undefined,
    closePanel: () => undefined,
    text,
  };
  return {
    ctx,
    statuses,
    clientListenerCount: () => clientListeners.size,
    swap(next: SyncFacade | undefined) {
      facade = next;
      for (const cb of [...clientListeners]) cb();
    },
  };
}

const layer = {} as HTMLElement;

describe("sync-status part", () => {
  test("publishes the facade's status as soon as it starts", () => {
    const host = makeHost(makeFacade({ requested: false, effective: "pending" }));
    const stop = syncStatusPart.start(host.ctx, layer);
    expect(host.statuses.at(-1)).toBe("sync_pending");
    stop();
  });

  test("follows facade changes while running", () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const host = makeHost(facade);
    const stop = syncStatusPart.start(host.ctx, layer);
    facade.set({ requested: false, effective: "pending" });
    expect(host.statuses.at(-1)).toBe("sync_pending");
    facade.set({ requested: true, effective: "on" });
    expect(host.statuses.at(-1)).toBe(null);
    stop();
  });

  test("re-points to the active client's facade on client change", () => {
    const first = makeFacade({ requested: false, effective: "pending" });
    const second = makeFacade({ requested: false, effective: "off" });
    const host = makeHost(first);
    const stop = syncStatusPart.start(host.ctx, layer);
    host.swap(second);
    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(1);
    expect(host.statuses.at(-1)).toBe(null);
    stop();
  });

  test("stop unsubscribes, removes the client listener, and clears the status", () => {
    const facade = makeFacade({ requested: false, effective: "pending" });
    const host = makeHost(facade);
    const stop = syncStatusPart.start(host.ctx, layer);
    stop();
    expect(facade.listenerCount()).toBe(0);
    expect(host.clientListenerCount()).toBe(0);
    expect(host.statuses.at(-1)).toBe(null);
  });
});
