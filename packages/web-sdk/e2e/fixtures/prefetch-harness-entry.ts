// Browser harness for the panel prefetch smoke tests. Bundled by `build:e2e-prefetch`
// into e2e/.build/prefetch. Unlike harness-entry.ts, the panel data here is the real
// lazy adapter (lazyRealPanelData) over a fake node host that records every read.
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";
import { lazyRealPanelData } from "../../src/ui/panel-data-loader";

interface Call {
  readonly name: string;
  readonly at: number;
}

const calls: Call[] = [];
const record = (name: string) => calls.push({ name, at: performance.now() });

const ok = <T>(data: T) => ({ ok: true as const, data });

const host = {
  account: {
    index: {
      spaces: {
        async list() {
          record("spaces.list");
          return ok([]);
        },
      },
      applications: {
        async list() {
          record("applications.list");
          return ok([]);
        },
      },
    },
  },
  delegations: {
    async query() {
      record("delegations.query");
      return ok({ items: [] });
    },
    async status() {
      return ok({});
    },
    async revoke() {
      return ok({});
    },
  },
  storage: {
    async status() {
      record("storage.status");
      return ok({
        usedBytes: 1073741824,
        limitBytes: 5368709120,
        state: "ok" as const,
        manageUrl: "https://account.tinycloud.xyz/storage",
      });
    },
  },
  hosts: ["https://node.example.test"],
  did: "did:key:z6MkFake",
  sessionDid: "did:key:z6MkSessionFake",
  async activeNodeIdentity() {
    return { origin: "https://node.example.test", nodeDid: "did:key:z6MkNodeFake" };
  },
};

const syncListeners = new Set<() => void>();
const facade = {
  get state() {
    return { requested: false, effective: "off" };
  },
  subscribe(cb: () => void) {
    syncListeners.add(cb);
    return () => {
      syncListeners.delete(cb);
    };
  },
  async setEnabled() {},
  async wipeLocalData() {},
};

const source = {
  signedIn: () => true,
  get sync() {
    return facade;
  },
  storage: host.storage,
};

let handle: UiClientHandle | undefined;

const w = window as unknown as Record<string, unknown>;
w.__tc = {
  mount() {
    handle?.unregister();
    handle = registerUiClient({
      ui: { developerMode: false },
      source: source as never,
      manifestAppId: () => "e2e-prefetch",
      data: lazyRealPanelData(host as never, () => "e2e-prefetch"),
    });
    w.tc = { ui: handle.api };
    return performance.now();
  },
  // Stands in for tcw's sign-in or restore: arms the pull, then waits for the lazy entry to load.
  async arm() {
    handle?.armPrefetch();
    await import("../../src/ui/panel-data-entry");
    await new Promise((resolve) => setTimeout(resolve, 0));
    return true;
  },
  // Sign-out path: clears this client's view state and cancels a pending pull.
  reset() {
    handle?.reset();
    return true;
  },
  open() {
    handle?.api.open();
    return performance.now();
  },
  calls() {
    return calls.slice();
  },
};
