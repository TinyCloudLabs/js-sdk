// Browser harness for the prompts smoke test. Bundled by `build:e2e-prompts`
// into e2e/.build/prompts.bundle.js and served by the spec. It mounts the real
// UI host and runs the production prompt paths (ModalSpaceCreationHandler for
// space creation, showPermissionRequestModal for permissions) with the prompt
// scope the host registered, so a reset dismisses pending prompts through the
// same scope. The spec injects no init script; everything is driven through
// window.__tc.
import { registerUiClient, type UiClientHandle, type UiConfig } from "../../src/ui/index";
import { ModalSpaceCreationHandler } from "../../src/authorization/WebSpaceCreationHandler";
import { showPermissionRequestModal, showSpaceCreationModal } from "../../src/notifications/ModalManager";
import { applyLegacyNotificationKeys } from "../../src/notifications/legacy-config";

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
let keeper: UiClientHandle | undefined;

function register(ui: UiConfig | false | undefined): UiClientHandle {
  return registerUiClient({
    ui,
    source: source as never,
    manifestAppId: () => "e2e-prompts-smoke",
  });
}

// Replaces both clients. With a keeper, the host stays mounted when the
// prompt client unregisters, so only prompt dismissal can remove its prompts.
function attach(withKeeper: boolean, ui?: UiConfig | false): void {
  handle?.unregister();
  keeper?.unregister();
  keeper = withKeeper ? register(ui) : undefined;
  handle = register(ui);
}

const w = window as unknown as Record<string, unknown>;
w.__tc = {
  mount() {
    attach(false);
    return true;
  },
  mountWithKeeper() {
    attach(true);
    return true;
  },
  mountWithConfig(legacy: Parameters<typeof applyLegacyNotificationKeys>[0]) {
    // Same mapping as TinyCloudWeb's constructor, so legacy keys reach the host as ui.
    attach(false, applyLegacyNotificationKeys(legacy).ui);
    return true;
  },
  openSpaceCreation() {
    if (handle === undefined) throw new Error("mount() must run first");
    delete w.__spaceResult;
    delete w.__spaceError;
    const handler = new ModalSpaceCreationHandler({
      promptScope: handle.promptScope,
      timeoutMs: 0,
      toast: (request) => handle?.toast(request) ?? false,
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
  openPermission(extraEntries = 0) {
    if (handle === undefined) throw new Error("mount() must run first");
    delete w.__permResult;
    delete w.__permError;
    const additional = Array.from({ length: extraEntries }, (_, i) => ({
      service: "tinycloud.kv",
      space: "e2e",
      path: `extra-${i}/`,
      actions: ["tinycloud.kv/get"],
    }));
    showPermissionRequestModal({ appName: "E2E App", additional }, handle.promptScope).then(
      (result) => {
        w.__permResult = result.approved;
      },
      (error: unknown) => {
        w.__permError = String(error);
      },
    );
    return true;
  },
  openThrowingSpaceCreation() {
    if (handle === undefined) throw new Error("mount() must run first");
    // Its onDismiss throws, so the next prompt that displaces it sees the error.
    showSpaceCreationModal(
      {
        onCreateSpace: async () => {},
        onDismiss: () => {
          throw new Error("probe onDismiss");
        },
      },
      handle.promptScope,
    );
    return true;
  },
  reset() {
    handle?.reset();
    return true;
  },
  unregister() {
    handle?.unregister();
    handle = undefined;
    return true;
  },
};
