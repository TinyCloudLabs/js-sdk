// Browser harness for the prompts smoke test. Bundled by `build:e2e-prompts`
// into e2e/.build/prompts.bundle.js and served by the spec. It mounts the real
// UI host and runs the production space-creation path
// (ModalSpaceCreationHandler) with the prompt scope the host registered, so a
// reset dismisses the pending prompt through the same scope. The spec injects
// no init script; everything is driven through window.__tc.
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";
import { ModalSpaceCreationHandler } from "../../src/authorization/WebSpaceCreationHandler";

type SyncState = { requested: boolean; effective: string; reason?: string };

let syncState: SyncState = { requested: false, effective: "off" };
const listeners = new Set<() => void>();

function emit(next: SyncState) {
  syncState = next;
  for (const cb of listeners) cb();
}

const facade = {
  get state() {
    return syncState;
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  async setEnabled(on: boolean) {
    emit({ requested: on, effective: on ? "on" : "off" });
  },
  async wipeLocalData() {
    emit({ requested: false, effective: "off" });
  },
};

const storage = {
  async status() {
    return {
      ok: true as const,
      data: {
        usedBytes: 1073741824,
        limitBytes: 5368709120,
        state: "ok" as const,
        manageUrl: "https://account.tinycloud.xyz/storage",
      },
    };
  },
};

const source = {
  signedIn: () => true,
  get sync() {
    return facade;
  },
  storage,
};

let handle: UiClientHandle | undefined;

const w = window as unknown as Record<string, unknown>;
w.__tc = {
  mount() {
    handle?.unregister();
    handle = registerUiClient({
      ui: undefined as never,
      source: source as never,
      manifestAppId: () => "e2e-prompts-smoke",
    });
    return true;
  },
  openSpaceCreation() {
    if (handle === undefined) throw new Error("mount() must run first");
    delete w.__spaceResult;
    delete w.__spaceError;
    const handler = new ModalSpaceCreationHandler({
      promptScope: handle.promptScope,
      timeoutMs: 0,
    });
    handler
      .confirmSpaceCreation({ spaceId: "space-e2e", host: "tinycloud.test" } as never)
      .then(
        (result) => {
          w.__spaceResult = result;
        },
        (error: unknown) => {
          w.__spaceError = String(error);
        },
      );
    return true;
  },
  reset() {
    handle?.unregister();
    handle = undefined;
    return true;
  },
};
