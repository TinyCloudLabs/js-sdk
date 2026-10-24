// Browser harness for the settings-panel smoke test. Bundled by
// `build:e2e-ui` into e2e/.build/ui.bundle.js and served by the spec.
// It mounts the real UI module and exposes window.__tc for the spec to drive.
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";
import { toastStore } from "../../src/ui/parts/toasts";
import type { ToastKind } from "../../src/ui/toast-store";
import { createStubPanelData, type StubSeed } from "../../src/ui/stub/index";
import { createRequestLog, sampleRows, type LogRow } from "./request-log";
import type { NodeRow, PanelDataFactory, ViewResult } from "../../src/ui/data";

// What a spec pins with page.addInitScript before the page loads: window.__TC_STUB_SEED__ (a JSON string).
// The stub's per-view results, plus `requests`, the request log rows the harness itself serves.
// JSON carries no Date, so a nodes row's ISO `lastSeenAt` string is revived here.
type SeedNodeRow = Omit<NodeRow, "lastSeenAt"> & { lastSeenAt?: string };
type SeedJson = Omit<StubSeed, "nodes"> & { nodes?: ViewResult<readonly SeedNodeRow[]>; requests?: LogRow[] };
type HarnessSeed = StubSeed & { requests?: LogRow[] };

function reviveRow(row: SeedNodeRow): NodeRow {
  const { lastSeenAt, ...rest } = row;
  return lastSeenAt === undefined ? rest : { ...rest, lastSeenAt: new Date(lastSeenAt) };
}

function harnessSeed(): HarnessSeed {
  const raw: unknown = Reflect.get(window, "__TC_STUB_SEED__");
  if (typeof raw !== "string") return {};
  const { nodes, ...rest }: SeedJson = JSON.parse(raw);
  if (nodes === undefined) return rest;
  if (nodes.state !== "ready") return { ...rest, nodes };
  return { ...rest, nodes: { state: "ready", data: nodes.data.map(reviveRow) } };
}

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

// Request log rows: the mockup's sample rows, or `requests` from the seed.
const requestLog = createRequestLog(harnessSeed().requests ?? sampleRows());
let signOutCount = 0;
let signedIn = true;
const source = {
  signedIn: () => signedIn,
  get sync() {
    return facade;
  },
  requests: requestLog.reader,
  storage,
  async signOut() {
    signOutCount += 1;
    signedIn = false;
  },
};

const revokeLog: string[] = [];

// Wraps the stub data factory so every revoke the panel asks for is recorded.
function loggedRevokes(factory: PanelDataFactory): PanelDataFactory {
  return (client) => {
    const source = factory(client);
    return {
      ...source,
      revoke: (cid: string) => {
        revokeLog.push(cid);
        return source.revoke(cid);
      },
    };
  };
}

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
      data: loggedRevokes(createStubPanelData(harnessSeed())),
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
  // A receipt slip in the host layer, the way a section raises one. No section does yet, so the spec drives the region directly.
  async showReceipt() {
    const layer = document.querySelector("[data-tinycloud-ui]")?.shadowRoot?.querySelector<HTMLElement>(".layer");
    if (!layer) return false;
    const { mountToastRegion } = await import("../../src/ui/panel-toasts");
    const { createToastStore } = await import("../../src/ui/toast-store");
    return mountToastRegion(layer, createToastStore(), (request) => toastStore.push(request)).receipt({
      titleCode: "panel.title",
      bodyCode: "panel.title",
      rows: [
        { labelCode: "panel.close", value: "rcpt_EXAMPLE_a1b2" },
        { labelCode: "panel.back", value: "bafkreiEXAMPLE" },
      ],
    });
  },
  // Sets the sync state the panel renders from, so a spec can reach states the stub facade never produces.
  setSync(next: SyncState) {
    emit(next);
    return true;
  },
  // How many times the panel's Sign out reached the client. Checked by the sign-out spec.
  signOutCalls() {
    return signOutCount;
  },
  // The request log the Activity section reads: add a request, clear the log, or count its listeners.
  logPush(row: LogRow) {
    requestLog.push(row);
    return true;
  },
  logClear() {
    requestLog.clear();
    return true;
  },
  logListeners() {
    return requestLog.listeners();
  },
  // The CIDs the panel asked the data source to revoke, in order. Checked by the delegations spec.
  revokeCalls() {
    return revokeLog.slice();
  },
};
