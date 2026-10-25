// Browser harness for the settings-panel smoke test. Bundled by
// `build:e2e-ui` into e2e/.build/ui.bundle.js and served by the spec.
// It mounts the real UI module and exposes window.__tc for the spec to drive.
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";
import { toastStore } from "../../src/ui/parts/toasts";
import type { ToastKind } from "../../src/ui/toast-store";
import { showPermissionRequestModal } from "../../src/notifications/lazy-prompts";
import { createStubPanelData, type StubSeed } from "../../src/ui/stub/index";
import { createRequestLog, sampleRows, type LogRow } from "./request-log";
import type { LocalCopyStatus, NodeRow, PanelDataFactory, ViewResult } from "../../src/ui/data";

// What a spec pins with page.addInitScript before the page loads: window.__TC_STUB_SEED__ (a JSON string or an object).
// The stub's per-view results, plus `requests`, the request log rows the harness itself serves.
// JSON carries no Date, so a nodes row's ISO `lastSeenAt` string is revived here (and the local copy's `lastSyncedAt`).
type SeedNodeRow = Omit<NodeRow, "lastSeenAt"> & { lastSeenAt?: string };
type SeedLocalCopy = Omit<LocalCopyStatus, "lastSyncedAt"> & { lastSyncedAt?: string };
type SeedJson = Omit<StubSeed, "nodes" | "localCopy"> & {
  nodes?: ViewResult<readonly SeedNodeRow[]>;
  localCopy?: SeedLocalCopy;
  requests?: LogRow[];
};
type HarnessSeed = StubSeed & { requests?: LogRow[] };

function reviveRow(row: SeedNodeRow): NodeRow {
  const { lastSeenAt, ...rest } = row;
  return lastSeenAt === undefined ? rest : { ...rest, lastSeenAt: new Date(lastSeenAt) };
}

function harnessSeed(): HarnessSeed {
  const raw: unknown = Reflect.get(window, "__TC_STUB_SEED__");
  // Specs set it as a JSON string, or, for plain data without dates, as an object.
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof parsed !== "object" || parsed === null) return {};
  const { nodes, localCopy, ...others }: SeedJson = parsed;
  const rest: HarnessSeed = { ...others };
  if (localCopy !== undefined) {
    // JSON carries no Date either: the local copy's ISO `lastSyncedAt` string is revived.
    const { lastSyncedAt, ...copy } = localCopy;
    rest.localCopy = lastSyncedAt === undefined ? copy : { ...copy, lastSyncedAt: new Date(lastSyncedAt) };
  }
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

// Fake replica storage with the real database name, so a spec can watch indexedDB.databases() across wipe and sign-out.
const REPLICA_DB = "tinycloud-replica-kv";

function replicaDbCreate(): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(REPLICA_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("entries");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("entries", "readwrite");
      tx.objectStore("entries").put("ciphertext", "k1");
      tx.oncomplete = () => {
        open.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

function replicaDbDelete(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(REPLICA_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("delete blocked"));
  });
}

/** One answer of the fake `purgeLocalCopy`. "real" deletes the database; "skip" reports success without deleting. */
type PurgeAnswer = "real" | "skip" | "fail" | "fail-now";
let purgeAnswers: PurgeAnswer[] | undefined;
let purgeCalls = 0;
const callLog: string[] = [];

type WipeMode = "ok" | "fail" | "hold";
let wipeMode: WipeMode = "ok";
let wipeCalls = 0;
let releaseWipe: (() => void) | undefined;

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
    wipeCalls += 1;
    const before = syncState;
    emit({ requested: before.requested, effective: "wiping" });
    if (wipeMode === "hold") await new Promise<void>((resolve) => (releaseWipe = resolve));
    if (wipeMode === "fail") {
      emit(before);
      throw Object.assign(new Error("wipe failed"), { code: "RAW_CODE_NOT_SHOWN" });
    }
    await replicaDbDelete();
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
    callLog.push("signOut:start");
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    signedIn = false;
    callLog.push("signOut:end");
  },
  // Defined only once a spec has chosen purge answers, so other specs keep the host's own sign-out.
  get purgeLocalCopy() {
    if (purgeAnswers === undefined) return undefined;
    return async () => {
      const answers = purgeAnswers ?? [];
      const answer = answers[Math.min(purgeCalls, answers.length - 1)] ?? "real";
      purgeCalls += 1;
      callLog.push(`purge:${answer}`);
      if (answer === "fail") return { ok: false as const, retryNow: false };
      if (answer === "fail-now") return { ok: false as const, retryNow: true };
      if (answer === "real") await replicaDbDelete();
      return { ok: true as const };
    };
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
// The manifest display name the next mount() reports; undefined keeps the app id as the label.
let manifestName: string | undefined;

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
      manifestName: () => manifestName,
      data: loggedRevokes(createStubPanelData(harnessSeed())),
    });
    w.tc = { ui: handle.api };
    return true;
  },
  // A permission prompt raised through the eager front, as tcw does. Its answer lands on window.__permResult.
  openPermission() {
    if (handle === undefined) throw new Error("mount() must run first");
    delete w.__permResult;
    showPermissionRequestModal({ appName: "E2E App", additional: [] }, handle.promptScope).then((result) => {
      w.__permResult = result.approved;
    });
    return true;
  },
  setManifestName(name: string | undefined) {
    manifestName = name;
    return true;
  },
  setSignedIn(value: boolean) {
    signedIn = value;
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
  // Creates the fake replica database with the real name and one record.
  createReplicaDb: replicaDbCreate,
  async replicaDatabases() {
    return (await indexedDB.databases()).map((info) => info.name ?? "");
  },
  // Answers for successive purgeLocalCopy calls; the last repeats. Call before mount().
  setPurge(answers: PurgeAnswer[]) {
    purgeAnswers = answers;
    purgeCalls = 0;
    return true;
  },
  setWipe(mode: WipeMode) {
    wipeMode = mode;
    return true;
  },
  releaseWipe() {
    releaseWipe?.();
    return true;
  },
  wipeCalls() {
    return wipeCalls;
  },
  purgeCalls() {
    return purgeCalls;
  },
  // Ordered record of sign-out and purge calls.
  callLog() {
    return [...callLog];
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
