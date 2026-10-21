// Browser harness for the storage e2e spec. Bundled by `build:e2e-storage`
// into e2e/.build/storage.bundle.js. It mounts the real UI module; the spec
// picks the storage status with `configure` and drives the own-storage episode
// with `setEpisode`, both through window.__tc.
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";

type StorageConfig =
  | { kind: "known"; manageUrl: string }
  | { kind: "unlimited"; state: "ok" | "full" }
  | { kind: "needs_permission" }
  | { kind: "unavailable" };

const KNOWN_USED = 1073741824;
const KNOWN_LIMIT = 5368709120;

let config: StorageConfig = {
  kind: "known",
  manageUrl: "https://account.tinycloud.xyz/storage",
};
let episodeOn = false;
const episodeListeners = new Set<() => void>();

const storage = {
  async status() {
    switch (config.kind) {
      case "known":
        return {
          data: {
            usedBytes: KNOWN_USED,
            limitBytes: KNOWN_LIMIT,
            state: "ok" as const,
            manageUrl: config.manageUrl,
          },
        };
      case "unlimited":
        return {
          data: { usedBytes: KNOWN_USED, limitBytes: null, state: config.state },
        };
      case "needs_permission":
        return { error: { code: "PERMISSION_DENIED" } };
      case "unavailable":
        return { error: { code: "unsupported" } };
    }
  },
};

const storageEpisode = {
  current: () => (episodeOn ? {} : undefined),
  subscribe(cb: () => void) {
    episodeListeners.add(cb);
    return () => {
      episodeListeners.delete(cb);
    };
  },
  // The harness has no delegated owners, so no delegated notification ever fires.
  subscribeDelegated() {
    return () => undefined;
  },
};

function setEpisode(on: boolean) {
  episodeOn = on;
  for (const cb of [...episodeListeners]) cb();
}

const source = {
  signedIn: () => true,
  storage,
  storageEpisode,
};

let handle: UiClientHandle | undefined;

const w = window as unknown as Record<string, unknown>;
w.__tc = {
  configure(next: StorageConfig) {
    config = next;
  },
  mount() {
    handle?.unregister();
    handle = registerUiClient({
      ui: undefined as never,
      source: source as never,
      manifestAppId: () => "e2e-storage",
    });
    w.tc = { ui: handle.api };
    return true;
  },
  setEpisode,
};
