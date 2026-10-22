// Browser harness for the settings-panel smoke test. Bundled by
// `build:e2e-ui` into e2e/.build/ui.bundle.js and served by the spec.
// It mounts the real UI module and exposes window.__tc for the spec to drive.
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";
import { toastStore } from "../../src/ui/parts/toasts";
import type { ToastKind } from "../../src/ui/toast-store";
import { createStubPanelData } from "../../src/ui/stub/index";

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
  // `ui` is passed through as given, so a spec can mount with toasts or the button off.
  mount(ui?: Parameters<typeof registerUiClient>[0]["ui"]) {
    handle?.unregister();
    // Developer mode is on by default so Activity is mounted; a spec overrides it by passing `developerMode: false`.
    handle = registerUiClient({
      ui: { developerMode: true, ...ui },
      source: source as never,
      manifestAppId: () => "e2e-settings-smoke",
      data: createStubPanelData(),
    });
    w.tc = { ui: handle.api };
    return true;
  },
  // Dispatches the same window rejection the SDK's error path raises for a TinyCloud failure.
  rejectWithTinyCloudError() {
    const event = new Event("unhandledrejection");
    Object.assign(event, { reason: new Error("TinyCloud storage failed") });
    window.dispatchEvent(event);
    return true;
  },
  // One toast of `kind` through the real store the panel renders from.
  toast(kind: ToastKind) {
    return toastStore.push({ kind, textCode: "panel.title" });
  },
  dismiss(id: string) {
    toastStore.dismiss(id);
  },
  // Sets the sync state the panel renders from, so a spec can reach states the stub facade never produces.
  setSync(next: SyncState) {
    emit(next);
    return true;
  },
};
