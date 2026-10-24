// Browser harness for the settings-panel smoke test. Bundled by
// `build:e2e-ui` into e2e/.build/ui.bundle.js and served by the spec.
// It mounts the real UI module and exposes window.__tc for the spec to drive.
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";
import { toastStore } from "../../src/ui/parts/toasts";
import type { ToastKind } from "../../src/ui/toast-store";
import { createStubPanelData, type StubSeed } from "../../src/ui/stub/index";

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

/** Stub data overrides: one optional field per section, read once from window.__TC_STUB_SEED__ (a JSON string or object). */
function readSeed(): StubSeed {
  const raw = (window as unknown as { __TC_STUB_SEED__?: unknown }).__TC_STUB_SEED__;
  if (raw === undefined) return {};
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return JSON.parse(text, (key, value) => (key === "lastSyncedAt" && typeof value === "string" ? new Date(value) : value)) as StubSeed;
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

let signOutCount = 0;
let signedIn = true;
const source = {
  signedIn: () => signedIn,
  get sync() {
    return facade;
  },
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
      data: createStubPanelData(readSeed()),
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
};
