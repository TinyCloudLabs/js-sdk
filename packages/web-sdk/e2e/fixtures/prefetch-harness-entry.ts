// Browser harness for the panel prefetch smoke tests. Bundled by `build:e2e-prefetch`
// into e2e/.build/prefetch. Unlike harness-entry.ts, the panel data here is the real
// lazy proxy (production wiring) over a fake node host that records every read.
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";

interface Call {
  readonly name: string;
  readonly at: number;
}

const calls: Call[] = [];

// Test-only clock offset. The adapter's TTLs and freshness text read Date.now(); `age` moves
// it forward so a snapshot goes stale without waiting out the 60 s / 10 s TTLs.
let clockOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockOffset;

// Fault controls set through `__tc.control`. `rtt` delays every read; `deny` answers
// PERMISSION_DENIED and `fail` answers NETWORK for the named reads.
const faults = { rtt: 0, deny: new Set<string>(), fail: new Set<string>() };

// Read gate. While closed, every read waits on it, so a refresh stays in flight until the test
// calls `hold(false)`. A timed RTT alone races the test's poll: the chip can flip before it looks.
let gate: Promise<void> | undefined;
let openGate: (() => void) | undefined;

async function respond<T>(name: string, service: string, data: T) {
  calls.push({ name, at: performance.now() });
  const held = gate;
  if (held) await held;
  if (faults.rtt > 0) await new Promise((resolve) => setTimeout(resolve, faults.rtt));
  if (faults.deny.has(name)) {
    return { ok: false as const, error: { code: "PERMISSION_DENIED", message: "denied", service } };
  }
  if (faults.fail.has(name)) {
    return { ok: false as const, error: { code: "NETWORK", message: "down", service } };
  }
  return { ok: true as const, data };
}

const host = {
  account: {
    index: {
      spaces: {
        async list() {
          return respond("spaces.list", "space", []);
        },
      },
      applications: {
        async list() {
          return respond("applications.list", "application", []);
        },
      },
    },
  },
  delegations: {
    async query() {
      return respond("delegations.query", "delegation", { items: [] });
    },
    async status() {
      return { ok: true as const, data: {} };
    },
    async revoke() {
      return { ok: true as const, data: {} };
    },
  },
  storage: {
    async status() {
      return respond("storage.status", "storage", {
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

// Sign-in state the harness client reports; `setSignedIn` and `signOut` change it.
let signedIn = true;

const source = {
  signedIn: () => signedIn,
  get sync() {
    return facade;
  },
  storage: host.storage,
};

let handle: UiClientHandle | undefined;

const w = window as unknown as Record<string, unknown>;
w.__tc = {
  mount(options: { developerMode?: boolean; signedIn?: boolean } = {}) {
    handle?.unregister();
    signedIn = options.signedIn ?? true;
    handle = registerUiClient({
      ui: { developerMode: options.developerMode ?? false },
      source: source as never,
      manifestAppId: () => "e2e-prefetch",
    });
    w.tc = { ui: handle.api };
    return performance.now();
  },
  // Stands in for tcw's sign-in or restore. `armPrefetch` and this import resolve the same
  // chunk, and the eager `.then` was registered first, so the live source exists when this resolves.
  async arm() {
    handle?.armPrefetch(host as never);
    await import("../../src/ui/panel-data-entry");
    return true;
  },
  // The user signs out: the client reports signed out, and its view state is cleared, as tcw's signOut does.
  signOut() {
    signedIn = false;
    handle?.reset();
    return true;
  },
  // Sign-out path: clears this client's view state and cancels a pending pull.
  reset() {
    handle?.reset();
    return true;
  },
  // `hold(true)` closes the read gate; `hold(false)` releases every read waiting on it.
  hold(closed: boolean) {
    if (closed && !gate) {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    } else if (!closed && gate) {
      const release = openGate;
      gate = undefined;
      openGate = undefined;
      release?.();
    }
    return true;
  },
  control(next: { rtt?: number; deny?: string[]; fail?: string[] }) {
    faults.rtt = next.rtt ?? 0;
    faults.deny = new Set(next.deny ?? []);
    faults.fail = new Set(next.fail ?? []);
    return true;
  },
  age(ms: number) {
    clockOffset += ms;
    return clockOffset;
  },
  open() {
    handle?.api.open();
    return performance.now();
  },
  close() {
    handle?.api.close();
    return true;
  },
  calls() {
    return calls.map((c) => ({ ...c }));
  },
};
