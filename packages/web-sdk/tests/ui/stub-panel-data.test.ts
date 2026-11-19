import { describe, expect, test } from "bun:test";

import type { PanelClient, SyncState } from "../../src/ui/slots";
import { createStubPanelData } from "../../src/ui/stub";

type FakeSync = {
  state: SyncState;
  subscribe(cb: () => void): () => void;
  setEnabled(on: boolean): Promise<void>;
  wipeLocalData(): Promise<void>;
  emit(): void;
};

function fakeSync(state: SyncState): FakeSync {
  const listeners = new Set<() => void>();
  return {
    state,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setEnabled: () => Promise.resolve(),
    wipeLocalData: () => Promise.resolve(),
    emit() {
      for (const cb of listeners) cb();
    },
  };
}

function clientWith(sync?: FakeSync): PanelClient {
  return { id: 1, sync } as unknown as PanelClient;
}

describe("createStubPanelData reads", () => {
  test("every read resolves to ready data labelled as stub", async () => {
    const source = createStubPanelData()(clientWith(fakeSync({ requested: false, effective: "off" })));

    const account = await source.account();
    const localNode = await source.localNode();
    const localCopy = await source.localCopy();
    const delegations = await source.delegations();
    const nodes = await source.nodes();
    const storage = await source.storage();

    for (const result of [account, localNode, localCopy, delegations, nodes, storage]) {
      expect(result.state).toBe("ready");
    }
    if (account.state !== "ready" || localNode.state !== "ready" || storage.state !== "ready") {
      throw new Error("stub reads must be ready");
    }
    expect(account.data.source).toBe("stub");
    expect(localNode.data.source).toBe("stub");
    expect(storage.data.source).toBe("stub");
  });

  test("local copy reports the sync facade state it is given", async () => {
    const source = createStubPanelData()(
      clientWith(fakeSync({ requested: true, effective: "on" })),
    );

    const copy = await source.localCopy();

    if (copy.state !== "ready") throw new Error("local copy must be ready");
    expect(copy.data.requested).toBe(true);
    expect(copy.data.effective).toBe("on");
  });

  test("local copy without a sync facade is off and unavailable", async () => {
    const source = createStubPanelData()(clientWith());

    const copy = await source.localCopy();

    if (copy.state !== "ready") throw new Error("local copy must be ready");
    expect(copy.data.requested).toBe(false);
    expect(copy.data.effective).toBe("unavailable");
  });

  test("revoke echoes the cid it was asked to revoke", async () => {
    const source = createStubPanelData()(clientWith());

    expect(await source.revoke("bafy-target")).toEqual({ ok: true, cid: "bafy-target" });
  });
});

describe("createStubPanelData subscriptions", () => {
  test("a sync change notifies the copy view until unsubscribed", async () => {
    const sync = fakeSync({ requested: false, effective: "off" });
    const source = createStubPanelData()(clientWith(sync));
    const views: string[] = [];

    const unsubscribe = source.subscribe((view) => views.push(view));
    sync.emit();
    unsubscribe();
    sync.emit();

    expect(views).toEqual(["copy"]);
  });
});
