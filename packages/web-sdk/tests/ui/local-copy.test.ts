import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { LocalCopyStatus, PanelDataSource, PanelView, ViewResult } from "../../src/ui/data";
import { localCopySection } from "../../src/ui/sections/local-copy";
import { createSectionDialogs } from "../../src/ui/section-dialogs";
import { createSignOutGuard } from "../../src/ui/sign-out-purge";
import type {
  PanelClient,
  SectionContext,
  PurgeLocalCopyResult,
  StatusCode,
  SyncEffective,
  SyncFacade,
  SyncState,
} from "../../src/ui/slots";
import { panelText } from "../../src/ui/strings-panel";
import type { ToastRequest } from "../../src/ui/toast-store";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "KeyboardEvent", "MouseEvent"];

let page: Window;
const saved = new Map<string, unknown>();
const cleanups: Array<() => void> = [];

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.KeyboardEvent = page.KeyboardEvent;
  g.MouseEvent = page.MouseEvent;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  page.document.body.innerHTML = "";
});

interface FacadeStub extends SyncFacade {
  setEnabledCalls: boolean[];
  wipeCalls: number;
  nextSetEnabled: () => Promise<void>;
  nextWipe: () => Promise<void>;
  listenerCount(): number;
  set(next: SyncState): void;
}

function makeFacade(initial: SyncState): FacadeStub {
  let state = initial;
  const listeners = new Set<() => void>();
  const stub: FacadeStub = {
    setEnabledCalls: [],
    wipeCalls: 0,
    nextSetEnabled: async () => undefined,
    nextWipe: async () => undefined,
    get state() {
      return state;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setEnabled(on) {
      stub.setEnabledCalls.push(on);
      return stub.nextSetEnabled();
    },
    wipeLocalData() {
      stub.wipeCalls += 1;
      return stub.nextWipe();
    },
    listenerCount: () => listeners.size,
    set(next) {
      state = next;
      for (const cb of [...listeners]) cb();
    },
  };
  return stub;
}

interface HeaderFake {
  topStatus(): StatusCode | null;
  onStatusChange(cb: () => void): () => void;
  set(next: StatusCode | null): void;
}

function makeHeader(initial: StatusCode | null = null): HeaderFake {
  let top = initial;
  const listeners = new Set<() => void>();
  return {
    topStatus: (): StatusCode | null => top,
    onStatusChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    set(next: StatusCode | null): void {
      top = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

const NOW = Date.now();
const COPY: LocalCopyStatus = {
  source: "stub",
  requested: true,
  effective: "on",
  lastSyncedAt: new Date(NOW - 2 * 60_000),
  pending: 3,
  bytesOnDevice: 48.2 * 1024 * 1024,
  folders: [
    { prefix: "notes/", state: "ok", items: 214, bytes: 6.4 * 1024 * 1024, waiting: 2 },
    { prefix: "recordings/", state: "syncing" },
  ],
};

interface Setup {
  facade?: SyncFacade | undefined;
  /** Result of `source.localCopy()`. Undefined: no data source. */
  copy?: ViewResult<LocalCopyStatus> | (() => Promise<ViewResult<LocalCopyStatus>>) | undefined;
  header?: HeaderFake;
  /** Replaces the default client, for sections that read sign-out state. */
  client?: PanelClient;
}

function setup(opts: Setup) {
  const toasts: ToastRequest[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const dialogs = createSectionDialogs(() => host);
  const header = opts.header ?? makeHeader();
  const sourceListeners = new Set<(view: PanelView) => void>();
  let reads = 0;
  const source =
    opts.copy === undefined
      ? undefined
      : ({
          localCopy: () => {
            reads += 1;
            return typeof opts.copy === "function" ? opts.copy() : Promise.resolve(opts.copy as ViewResult<LocalCopyStatus>);
          },
          subscribe(cb: (view: PanelView) => void) {
            sourceListeners.add(cb);
            return () => sourceListeners.delete(cb);
          },
        } as unknown as PanelDataSource);
  const client =
    opts.client ??
    ({ id: 1, signedIn: () => true, onReset: () => () => undefined, sync: opts.facade, storage: {} } as unknown as PanelClient);
  const ctx = {
    client: () => client,
    onClientChange: () => () => undefined,
    developerMode: () => false,
    setStatus: () => undefined,
    topStatus: header.topStatus,
    onStatusChange: header.onStatusChange,
    toastsEnabled: () => true,
    toast: (request: ToastRequest) => {
      toasts.push(request);
      return "t";
    },
    text: panelText,
    appLabel: () => "Fieldnotes",
    canHideButton: () => false,
    hideButton: () => undefined,
    closePanel: () => undefined,
    openSection: () => undefined,
    receipt: () => false,
    data: {
      source,
      latest: () => (opts.copy !== undefined && typeof opts.copy !== "function" ? opts.copy : undefined),
      age: () => undefined,
      refresh: () => Promise.resolve(),
      subscribe: () => () => undefined,
    },
    layout: () => "drawer",
    sections: () => [],
    requestRender: () => undefined,
    confirm: (request: Parameters<SectionContext["confirm"]>[0]) => dialogs.confirm(request),
    openDrawer: (request: Parameters<SectionContext["openDrawer"]>[0]) => dialogs.openDrawer(request),
  } as unknown as SectionContext;
  const el = document.createElement("div");
  host.append(el);
  const dispose = localCopySection.mount(el, ctx);
  cleanups.push(dispose);
  return {
    el,
    host,
    ctx,
    dispose,
    toasts,
    header,
    reads: () => reads,
    emitSource: (view: PanelView) => sourceListeners.forEach((cb) => cb(view)),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const ready = (data: Partial<LocalCopyStatus> = {}): ViewResult<LocalCopyStatus> => ({
  state: "ready",
  data: { ...COPY, ...data },
});
const state = (effective: SyncEffective, requested = effective !== "off", reason?: string): SyncState => ({
  requested,
  effective,
  reason,
});
const toggleOf = (el: HTMLElement) => el.querySelector("button.switch") as HTMLButtonElement;
const wipeBtn = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>("section.lc-wipe > button.action")][0] as HTMLButtonElement;
const wipeSection = (el: HTMLElement) => el.querySelector("section.lc-wipe") as HTMLElement;
const box = (el: HTMLElement) => el.querySelector<HTMLElement>(".confirm");
const keepBtn = (el: HTMLElement) => box(el)?.querySelectorAll<HTMLButtonElement>("button")[0] as HTMLButtonElement;
const confirmBtn = (el: HTMLElement) => box(el)?.querySelectorAll<HTMLButtonElement>("button")[1] as HTMLButtonElement;
const visible = (node: Element | null) => node !== null && !node.hasAttribute("hidden");
const bodyText = (el: HTMLElement) => el.textContent ?? "";
const neutral = panelText("sync.reason.unknown");

describe("availability", () => {
  test("unavailable without tc.sync, available with it", () => {
    const withSync = setup({ facade: makeFacade(state("off")) });
    expect(localCopySection.isAvailable(withSync.ctx)).toBe(true);
    const without = setup({ facade: undefined });
    expect(localCopySection.isAvailable(without.ctx)).toBe(false);
  });
});

describe("states", () => {
  test("off: switch off and enabled, off line instead of rows, no wipe without bytes", async () => {
    const { el } = setup({ facade: makeFacade(state("off")), copy: ready({ requested: false, effective: "off", bytesOnDevice: 0, folders: [], pending: 0 }) });
    await flush();
    expect(toggleOf(el).getAttribute("aria-checked")).toBe("false");
    expect(toggleOf(el).disabled).toBe(false);
    expect(bodyText(el)).toContain("The local copy is off. Nothing is kept on this device. Fieldnotes reads and writes your TinyCloud directly");
    expect(wipeSection(el).hidden).toBe(true);
    expect(el.querySelector(".lc-kv")?.closest("[hidden]")).not.toBeNull();
  });

  test("the Wipe button is described by the always-visible explanation next to it", async () => {
    const { el } = setup({ facade: makeFacade(state("on")), copy: ready() });
    await flush();
    const id = wipeBtn(el).getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const target = el.querySelector(`[id="${id}"]`);
    expect(target).toBe(el.querySelector(".lc-wipe > p"));
    expect(target?.textContent).toBe(
      "Erases TinyCloud's copy on this device. Your data stays on your TinyCloud; the app's own files are not touched.",
    );
    expect(target?.hasAttribute("hidden")).toBe(false);
  });

  test("each mount gets its own description id, so two sections never share one", async () => {
    const first = setup({ facade: makeFacade(state("on")), copy: ready() });
    const second = setup({ facade: makeFacade(state("on")), copy: ready() });
    await flush();
    const a = wipeBtn(first.el).getAttribute("aria-describedby");
    const b = wipeBtn(second.el).getAttribute("aria-describedby");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(document.querySelectorAll(`[id="${a}"]`)).toHaveLength(1);
  });

  test("off with bytes left on the device still offers the wipe", async () => {
    const { el } = setup({ facade: makeFacade(state("off")), copy: ready({ requested: false, effective: "off", bytesOnDevice: 1024, folders: [] }) });
    await flush();
    expect(wipeSection(el).hidden).toBe(false);
    expect(wipeSection(el).textContent).toContain(
      "Erases TinyCloud's copy on this device. Your data stays on your TinyCloud; the app's own files are not touched.",
    );
    expect(wipeSection(el).textContent).toContain("Wipe local data");
    expect(bodyText(el)).not.toContain("Nothing is kept on this device.");
  });

  test("on: status, ledger rows with dotted-leader rows, folders", async () => {
    const { el } = setup({ facade: makeFacade(state("on")), copy: ready() });
    await flush();
    expect(toggleOf(el).getAttribute("aria-checked")).toBe("true");
    expect(el.querySelector(".st")?.textContent).toBe("Synced 2 min ago");
    const rows = [...el.querySelectorAll(".lc-cozy > div")].map((row) => row.textContent);
    expect(rows).toEqual(["Waiting to sync3 changes", "Size on this device48.2 MiB"]);
    const folders = [...el.querySelectorAll("section.lc-sec dl.lc-kv > div")].map((row) => row.textContent);
    expect(folders).toEqual(["notes/214 items · 6.4 MiB · 2 waiting", "recordings/Syncing · details unknown"]);
    expect(el.querySelector(".lc-cnt")?.textContent).toBe("2");
  });

  test("waiting reads 'Nothing' at zero and '1 change' at one; a missing sync time reads 'unknown'", async () => {
    const zero = setup({ facade: makeFacade(state("on")), copy: ready({ pending: 0, lastSyncedAt: undefined }) });
    await flush();
    expect(zero.el.querySelector(".lc-cozy > div")?.textContent).toBe("Waiting to syncNothing");
    expect(zero.el.querySelector(".st")?.textContent).toBe("Last synced: unknown");
    const one = setup({ facade: makeFacade(state("on")), copy: ready({ pending: 1 }) });
    await flush();
    expect(one.el.querySelector(".lc-cozy > div")?.textContent).toBe("Waiting to sync1 change");
  });

  test("a folder with no known figures says 'details unknown'; a partly known folder says which figure is unknown", async () => {
    const { el } = setup({
      facade: makeFacade(state("on")),
      copy: ready({
        folders: [
          { prefix: "a/", state: "ok" },
          { prefix: "b/", state: "ok", items: 5 },
          { prefix: "c/", state: "ok", items: 5, bytes: 10, waiting: 0 },
        ],
      }),
    });
    await flush();
    const folders = [...el.querySelectorAll("section.lc-sec dl.lc-kv > div")].map((row) => row.textContent);
    expect(folders).toEqual(["a/details unknown", "b/5 items · size unknown · waiting unknown", "c/5 items · 10 B"]);
  });

  test("an unknown size is shown as 'unknown', never as zero", async () => {
    const { el } = setup({ facade: makeFacade(state("on")), copy: ready({ bytesOnDevice: undefined }) });
    await flush();
    const rows = [...el.querySelectorAll(".lc-cozy > div")].map((row) => row.textContent);
    expect(rows).toEqual(["Waiting to sync3 changes", "Size on this deviceunknown"]);
    expect(bodyText(el)).not.toContain("0 B");
    expect(bodyText(el)).not.toContain("Nothing is kept on this device");
  });

  test("an unknown count of waiting changes is shown as 'unknown', never as 'Nothing' or zero", async () => {
    const { el } = setup({ facade: makeFacade(state("on")), copy: ready({ pending: undefined as unknown as number }) });
    await flush();
    expect(el.querySelector(".lc-cozy > div")?.textContent).toBe("Waiting to syncunknown");
    expect(bodyText(el)).not.toContain("0 changes");
    wipeBtn(el).click();
    expect(box(el)?.textContent).toContain("It isn't known whether all changes have synced.");
    expect(box(el)?.textContent).not.toContain("0 changes");
  });

  test("values that are not valid figures count as unknown: negative, NaN and an invalid date", async () => {
    const { el } = setup({
      facade: makeFacade(state("on")),
      copy: ready({ bytesOnDevice: -1, pending: Number.NaN, lastSyncedAt: new Date(Number.NaN) }),
    });
    await flush();
    expect(el.querySelector(".st")?.textContent).toBe("Last synced: unknown");
    expect([...el.querySelectorAll(".lc-cozy > div")].map((row) => row.textContent)).toEqual([
      "Waiting to syncunknown",
      "Size on this deviceunknown",
    ]);
  });

  test("off with an unknown size does not claim nothing is kept, and still offers the wipe", async () => {
    const { el } = setup({ facade: makeFacade(state("off")), copy: ready({ requested: false, effective: "off", bytesOnDevice: undefined, folders: [] }) });
    await flush();
    expect(bodyText(el)).toContain("What is kept on this device is unknown.");
    expect(bodyText(el)).not.toContain("Nothing is kept on this device");
    expect(wipeSection(el).hidden).toBe(false);
  });

  test("off with no data read yet is also unknown: the wipe stays offered", async () => {
    const { el } = setup({ facade: makeFacade(state("off")) });
    await flush();
    expect(wipeSection(el).hidden).toBe(false);
  });

  test("switch follows requested, not effective, and stays enabled", async () => {
    const { el } = setup({ facade: makeFacade(state("on", false)), copy: ready() });
    await flush();
    expect(toggleOf(el).getAttribute("aria-checked")).toBe("false");
    expect(toggleOf(el).disabled).toBe(false);
  });

  const BUSY_WORD = { enabling: "Turning on the local copy", wiping: "Wiping local data" } as const;
  for (const effective of ["enabling", "wiping"] as const) {
    test(`${effective}: switch stays on but locked, wipe is disabled, and the exact word says why`, async () => {
      const { el } = setup({ facade: makeFacade(state(effective)), copy: ready() });
      await flush();
      expect(toggleOf(el).getAttribute("aria-checked")).toBe("true");
      expect(toggleOf(el).disabled).toBe(true);
      expect(wipeBtn(el).disabled).toBe(true);
      expect(visible(el.querySelector(".lc-state"))).toBe(true);
      expect(el.querySelector(".lc-state")?.textContent).toBe(BUSY_WORD[effective]);
    });
  }

  test("pending: switch locked, plain explanation, reason shown, wipe offered again", async () => {
    const { el } = setup({ facade: makeFacade(state("pending", true, "erase-pending")), copy: ready() });
    await flush();
    expect(toggleOf(el).disabled).toBe(true);
    expect(el.querySelector(".lc-state")?.textContent).toBe("The last wipe is not confirmed yet");
    expect(bodyText(el)).toContain(panelText("sync.reason.erase-pending"));
    expect(bodyText(el)).toContain("You can wipe it again below.");
    expect(wipeSection(el).hidden).toBe(false);
    expect(wipeBtn(el).disabled).toBe(false);
  });

  test("pending hides the word the header already shows, keeps the reason", async () => {
    const header = makeHeader("sync_pending");
    const { el } = setup({ facade: makeFacade(state("pending", true, "erase-pending")), copy: ready(), header });
    await flush();
    expect(visible(el.querySelector(".lc-state"))).toBe(false);
    expect(bodyText(el)).toContain(panelText("sync.reason.erase-pending"));
    header.set(null);
    expect(visible(el.querySelector(".lc-state"))).toBe(true);
  });

  test("pending shows its word when the header shows a different status", async () => {
    const header = makeHeader("storage_full");
    const { el } = setup({ facade: makeFacade(state("pending", true, "erase-pending")), copy: ready(), header });
    await flush();
    expect(visible(el.querySelector(".lc-state"))).toBe(true);
    expect(el.querySelector(".lc-state")?.textContent).toBe("The last wipe is not confirmed yet");
    header.set("sync_pending");
    expect(visible(el.querySelector(".lc-state"))).toBe(false);
    header.set("storage_full");
    expect(visible(el.querySelector(".lc-state"))).toBe(true);
  });

  test("unavailable: reason in words, switch locked, no wipe at all", async () => {
    const { el } = setup({ facade: makeFacade(state("unavailable", true, "unsupported-browser")), copy: ready() });
    await flush();
    expect(toggleOf(el).disabled).toBe(true);
    expect(bodyText(el)).toContain(panelText("sync.reason.unsupported-browser"));
    expect(bodyText(el)).toContain("Your data in TinyCloud is not affected.");
    expect(wipeSection(el).hidden).toBe(true);
  });

  test("an unknown effective value reads as unavailable with the neutral line; an unknown reason never shows its code", async () => {
    const weird = setup({ facade: makeFacade({ requested: true, effective: "rebooting" as unknown as SyncEffective }), copy: ready() });
    await flush();
    expect(bodyText(weird.el)).toContain(neutral);
    expect(bodyText(weird.el)).not.toContain("rebooting");
    expect(weird.el.innerHTML).not.toContain("rebooting");
    expect(wipeSection(weird.el).hidden).toBe(true);
    const odd = setup({ facade: makeFacade(state("unavailable", true, "weird-code")), copy: ready() });
    await flush();
    expect(bodyText(odd.el)).toContain(neutral);
    expect(bodyText(odd.el)).not.toContain("weird-code");
  });

  test("without a data source the switch and wipe still work from the facade alone", async () => {
    const { el } = setup({ facade: makeFacade(state("on")) });
    await flush();
    expect(toggleOf(el).getAttribute("aria-checked")).toBe("true");
    expect(wipeSection(el).hidden).toBe(false);
  });

  test("a failed read keeps the previous rows and shows the error line with a retry", async () => {
    let calls = 0;
    const facade = makeFacade(state("on"));
    const { el } = setup({
      facade,
      copy: () => Promise.resolve<ViewResult<LocalCopyStatus>>(++calls === 1 ? ready() : { state: "error", code: "x" }),
    });
    await flush();
    expect(el.querySelector(".lc-cozy > div")).not.toBeNull();
    facade.set(state("on", true));
    await flush();
    expect(el.querySelector(".lc-cozy > div")).not.toBeNull();
    const errorLine = el.querySelector<HTMLElement>("p[role=status]:not(.lc-state)");
    expect(errorLine?.hidden).toBe(false);
    expect(errorLine?.textContent).toBe(panelText("view.error"));
  });
});

describe("live updates", () => {
  test("a facade change repaints the switch and re-reads the rows", async () => {
    const facade = makeFacade(state("off"));
    const { el, reads } = setup({ facade, copy: ready({ effective: "off", requested: false, bytesOnDevice: 0, folders: [] }) });
    await flush();
    const before = reads();
    facade.set(state("on"));
    await flush();
    expect(toggleOf(el).getAttribute("aria-checked")).toBe("true");
    expect(reads()).toBeGreaterThan(before);
  });

  test("a data-source change for the copy view re-reads; other views do not", async () => {
    const { reads, emitSource } = setup({ facade: makeFacade(state("on")), copy: ready() });
    await flush();
    const before = reads();
    emitSource("storage");
    await flush();
    expect(reads()).toBe(before);
    emitSource("copy");
    await flush();
    expect(reads()).toBe(before + 1);
  });

  test("the switch keeps focus through a re-render", async () => {
    const facade = makeFacade(state("on"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    const toggle = toggleOf(el);
    toggle.focus();
    facade.set(state("on", true));
    facade.set(state("pending", true, "erase-pending"));
    await flush();
    expect(toggleOf(el)).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  test("dispose unsubscribes and ignores later changes", async () => {
    const facade = makeFacade(state("off"));
    const { el, dispose } = setup({ facade, copy: ready({ effective: "off", bytesOnDevice: 0 }) });
    await flush();
    expect(facade.listenerCount()).toBe(1);
    dispose();
    expect(facade.listenerCount()).toBe(0);
    facade.set(state("on"));
    await flush();
    expect(el.childElementCount).toBe(0);
  });
});

describe("switch", () => {
  test("off to on calls setEnabled(true) and busy-locks until it settles", async () => {
    const facade = makeFacade(state("off"));
    let release: () => void = () => undefined;
    facade.nextSetEnabled = () => new Promise<void>((resolve) => (release = resolve));
    const { el } = setup({ facade, copy: ready({ effective: "off", requested: false, bytesOnDevice: 0, folders: [] }) });
    await flush();
    toggleOf(el).click();
    toggleOf(el).click();
    expect(facade.setEnabledCalls).toEqual([true]);
    expect(toggleOf(el).disabled).toBe(true);
    release();
    await flush();
    expect(toggleOf(el).disabled).toBe(false);
  });

  test("a declined enable shows the declined line; an unknown code shows the neutral line, never the code", async () => {
    const facade = makeFacade(state("off"));
    facade.nextSetEnabled = () => Promise.reject(Object.assign(new Error("x"), { code: "declined" }));
    const { el } = setup({ facade });
    await flush();
    toggleOf(el).click();
    await flush();
    expect(el.querySelector(".error")?.textContent).toBe(panelText("sync.error.declined"));
    expect(toggleOf(el).disabled).toBe(false);
    facade.nextSetEnabled = () => Promise.reject(Object.assign(new Error("x"), { code: "ZZ_RAW" }));
    toggleOf(el).click();
    await flush();
    expect(el.querySelector(".error")?.textContent).toBe(neutral);
    expect(toggleOf(el).disabled).toBe(false);
  });

  test("on to off asks first: no wipe, no setEnabled until the destructive action", async () => {
    const facade = makeFacade(state("on"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    toggleOf(el).click();
    expect(box(el)).not.toBeNull();
    expect(facade.setEnabledCalls).toEqual([]);
    expect(facade.wipeCalls).toBe(0);
    expect(box(el)?.textContent).toContain("Turn off local copy and wipe local data?");
  });

  test("a disabled switch is ignored", async () => {
    const facade = makeFacade(state("enabling"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    toggleOf(el).click();
    expect(facade.setEnabledCalls).toEqual([]);
    expect(box(el)).toBeNull();
  });

  test("a requested-on copy with nothing on the device turns off without a confirm", async () => {
    const facade = makeFacade({ requested: true, effective: "off" });
    const { el } = setup({ facade, copy: ready({ effective: "off", bytesOnDevice: 0, folders: [] }) });
    await flush();
    toggleOf(el).click();
    expect(facade.setEnabledCalls).toEqual([false]);
    expect(box(el)).toBeNull();
  });

  test("a requested-on copy with an unknown size still asks before turning off", async () => {
    const facade = makeFacade({ requested: true, effective: "off" });
    const { el } = setup({ facade, copy: ready({ effective: "off", bytesOnDevice: undefined, folders: [] }) });
    await flush();
    toggleOf(el).click();
    expect(facade.setEnabledCalls).toEqual([]);
    expect(box(el)).not.toBeNull();
    expect(box(el)?.textContent).toContain("Turn off local copy and wipe local data?");
    expect(facade.wipeCalls).toBe(0);
  });
});

describe("wipe: two steps", () => {
  test("the Wipe button only opens the confirm; the safe action is focused; nothing is erased", async () => {
    const facade = makeFacade(state("on"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    expect(facade.wipeCalls).toBe(0);
    expect(box(el)?.getAttribute("role")).toBe("alertdialog");
    expect(keepBtn(el).textContent).toBe("Keep local data");
    expect(confirmBtn(el).textContent).toBe("Wipe local data");
    expect(document.activeElement).toBe(keepBtn(el));
  });

  test("the question says what happens and names unsynced changes", async () => {
    const { el } = setup({ facade: makeFacade(state("on")), copy: ready({ pending: 3 }) });
    await flush();
    wipeBtn(el).click();
    const text = box(el)?.textContent ?? "";
    expect(text).toContain("Erases TinyCloud's copy on this device. Your data stays on your TinyCloud");
    expect(text).toContain("3 changes haven't synced yet. Wiping now loses them.");
    expect(text).toContain("The copy downloads again the next time it syncs.");
  });

  test("Keep takes the safe action: no wipe, focus returns to the Wipe button", async () => {
    const facade = makeFacade(state("on"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    keepBtn(el).click();
    expect(box(el)).toBeNull();
    expect(facade.wipeCalls).toBe(0);
    expect(document.activeElement).toBe(wipeBtn(el));
  });

  test("Escape takes the safe action", async () => {
    const facade = makeFacade(state("on"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    keepBtn(el).dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(box(el)).toBeNull();
    expect(facade.wipeCalls).toBe(0);
    expect(document.activeElement).toBe(wipeBtn(el));
  });

  test("confirm wipes once, shows busy, then closes, toasts and moves focus to the switch", async () => {
    const facade = makeFacade(state("on"));
    let release: () => void = () => undefined;
    facade.nextWipe = () => new Promise<void>((resolve) => (release = resolve));
    const { el, toasts } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    const confirm = confirmBtn(el);
    confirm.click();
    confirm.click();
    confirm.dispatchEvent(new page.MouseEvent("click", { bubbles: true }));
    expect(facade.wipeCalls).toBe(1);
    expect(confirm.textContent).toBe("Wiping…");
    expect(confirm.disabled).toBe(true);
    expect(keepBtn(el).disabled).toBe(true);
    expect(toggleOf(el).disabled).toBe(true);
    expect(wipeBtn(el).disabled).toBe(true);
    release();
    await flush();
    expect(facade.wipeCalls).toBe(1);
    expect(box(el)).toBeNull();
    expect(toasts).toEqual([{ kind: "success", textCode: "local-copy.wipe.done" }]);
    expect(document.activeElement).toBe(toggleOf(el));
  });

  test("a stale confirm button cannot wipe once its box is gone", async () => {
    const facade = makeFacade(state("on"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    const stale = confirmBtn(el);
    keepBtn(el).click();
    stale.click();
    await flush();
    expect(facade.wipeCalls).toBe(0);
  });

  test("a confirm closes when the state stops allowing a wipe, and its button then does nothing", async () => {
    const facade = makeFacade(state("on"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    const stale = confirmBtn(el);
    facade.set(state("unavailable", true, "storage-blocked"));
    await flush();
    expect(box(el)).toBeNull();
    stale.click();
    await flush();
    expect(facade.wipeCalls).toBe(0);
  });

  test("a confirm cannot fire while the facade is enabling or wiping", async () => {
    for (const blocked of ["enabling", "wiping"] as const) {
      const facade = makeFacade(state("on"));
      const { el } = setup({ facade, copy: ready() });
      await flush();
      wipeBtn(el).click();
      const stale = confirmBtn(el);
      facade.set(state(blocked));
      await flush();
      stale.click();
      await flush();
      expect(facade.wipeCalls).toBe(0);
    }
  });

  test("a failed wipe shows a neutral line and a retry; the copy is not claimed gone; retry asks again", async () => {
    const facade = makeFacade(state("on"));
    facade.nextWipe = () => Promise.reject(Object.assign(new Error("x"), { code: "RAW_CODE" }));
    const { el, toasts } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    confirmBtn(el).click();
    await flush();
    expect(facade.wipeCalls).toBe(1);
    expect(toasts).toEqual([]);
    expect(box(el)).toBeNull();
    const fail = el.querySelector<HTMLElement>(".lc-wipe .lc-fail");
    expect(fail?.hidden).toBe(false);
    expect(fail?.textContent).toContain("The wipe didn't finish. The copy may still be on this device.");
    expect(bodyText(el)).not.toContain("RAW_CODE");
    expect(bodyText(el)).not.toContain("wiped. Your");
    const retry = fail?.querySelector("button") as HTMLButtonElement;
    expect(document.activeElement).toBe(retry);
    retry.click();
    expect(box(el)).not.toBeNull();
    expect(facade.wipeCalls).toBe(1);
    facade.nextWipe = async () => undefined;
    confirmBtn(el).click();
    await flush();
    expect(facade.wipeCalls).toBe(2);
    expect(el.querySelector<HTMLElement>(".lc-wipe .lc-fail")?.hidden).toBe(true);
  });

  test("turning the copy off wipes first, then turns it off", async () => {
    const order: string[] = [];
    const facade = makeFacade(state("on"));
    facade.nextWipe = async () => void order.push("wipe");
    const original = facade.setEnabled.bind(facade);
    facade.setEnabled = (on) => {
      order.push(`enable:${on}`);
      return original(on);
    };
    const { el } = setup({ facade, copy: ready() });
    await flush();
    toggleOf(el).click();
    confirmBtn(el).click();
    await flush();
    expect(order).toEqual(["wipe", "enable:false"]);
  });

  test("turning off does not turn the copy off when the wipe fails", async () => {
    const facade = makeFacade(state("on"));
    facade.nextWipe = () => Promise.reject(new Error("x"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    toggleOf(el).click();
    confirmBtn(el).click();
    await flush();
    expect(facade.setEnabledCalls).toEqual([]);
    expect(el.querySelector<HTMLElement>(".lc-wipe .lc-fail")?.hidden).toBe(false);
  });

  test("the wipe is offered from pending, so an unconfirmed erase can be retried", async () => {
    const facade = makeFacade(state("pending", true, "erase-pending"));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    confirmBtn(el).click();
    await flush();
    expect(facade.wipeCalls).toBe(1);
  });

  test("dispose while a wipe runs leaves the DOM alone and still reports the result", async () => {
    const facade = makeFacade(state("on"));
    let release: () => void = () => undefined;
    facade.nextWipe = () => new Promise<void>((resolve) => (release = resolve));
    const { el, toasts, dispose } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    confirmBtn(el).click();
    dispose();
    release();
    await flush();
    expect(el.childElementCount).toBe(0);
    expect(toasts).toHaveLength(1);
  });

  test("Escape during a running wipe does not cancel it: the wiping state stays shown and the wipe completes", async () => {
    const facade = makeFacade(state("on"));
    let release: () => void = () => undefined;
    facade.nextWipe = () => new Promise<void>((resolve) => (release = resolve));
    const { el, toasts } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    const open = box(el) as HTMLElement;
    confirmBtn(el).click();
    open.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(facade.wipeCalls).toBe(1);
    expect(visible(el.querySelector(".lc-state"))).toBe(true);
    expect(el.querySelector(".lc-state")?.textContent).toBe("Wiping local data");
    expect(toggleOf(el).disabled).toBe(true);
    expect(wipeBtn(el).disabled).toBe(true);
    release();
    await flush();
    expect(toasts).toEqual([{ kind: "success", textCode: "local-copy.wipe.done" }]);
    expect(el.querySelector(".lc-state")?.hasAttribute("hidden")).toBe(true);
  });

  test("after a failed wipe, focus goes to the heading when a state change hid the wipe section", async () => {
    const facade = makeFacade(state("on"));
    let fail: (error: Error) => void = () => undefined;
    facade.nextWipe = () => new Promise<void>((_, reject) => (fail = reject));
    const { el } = setup({ facade, copy: ready() });
    await flush();
    wipeBtn(el).click();
    confirmBtn(el).click();
    facade.set(state("unavailable", true, "storage-blocked"));
    expect(wipeSection(el).hidden).toBe(true);
    fail(new Error("x"));
    await flush();
    expect(document.activeElement?.tagName).toBe("H3");
    expect(document.activeElement).not.toBe(el.querySelector(".lc-wipe .lc-fail button"));
  });
});

describe("purge warning after sign-out", () => {
  /** A signed-out client whose sign-out already ran through the guard, with `purges` answering each purge call. */
  async function signedOutWith(purges: PurgeLocalCopyResult[]) {
    const state = { signedIn: true };
    let calls = 0;
    const raw = {
      id: 1,
      signedIn: () => state.signedIn,
      onReset: () => () => undefined,
      storage: {},
      sync: makeFacade({ requested: false, effective: "off" }),
      signOut: async () => {
        state.signedIn = false;
      },
      purgeLocalCopy: async () => {
        const answer = purges[Math.min(calls, purges.length - 1)] as PurgeLocalCopyResult;
        calls += 1;
        return answer;
      },
    } as unknown as PanelClient;
    const guard = createSignOutGuard(() => undefined);
    const client = guard(raw) as PanelClient;
    await client.signOut?.();
    return { client, state, calls: () => calls };
  }
  const purgeBox = (el: HTMLElement) => el.querySelector<HTMLElement>(".lc-purge") as HTMLElement;

  test("a failed purge shows the neutral warning and a retry; the retry runs the purge again", async () => {
    const { client, calls } = await signedOutWith([{ ok: false, retryNow: false }, { ok: true }]);
    const { el, toasts } = setup({ client, facade: client.sync });
    await flush();
    expect(purgeBox(el).hidden).toBe(false);
    expect(purgeBox(el).textContent).toContain("The local copy on this browser was not removed yet.");
    expect(purgeBox(el).textContent).not.toContain("Signed out");
    expect(purgeBox(el).textContent).not.toContain("we'll try again");
    expect(calls()).toBe(1);
    const retry = purgeBox(el).querySelector("button") as HTMLButtonElement;
    retry.click();
    expect(retry.disabled).toBe(true);
    retry.click();
    await flush();
    expect(calls()).toBe(2);
    expect(purgeBox(el).hidden).toBe(true);
    expect(toasts).toEqual([{ kind: "success", textCode: "local-copy.purge.done" }]);
    expect(document.activeElement?.tagName).toBe("H3");
  });

  test("when the keys may still be in the database the warning says the copy may be readable", async () => {
    const { client } = await signedOutWith([{ ok: false, retryNow: true }]);
    const { el } = setup({ client, facade: client.sync });
    await flush();
    expect(purgeBox(el).textContent).toContain("It may still be readable here.");
    expect(purgeBox(el).textContent).not.toContain("keep trying");
  });

  test("a failed retry keeps the warning and puts focus back on Retry", async () => {
    const { client } = await signedOutWith([{ ok: false, retryNow: false }]);
    const { el } = setup({ client, facade: client.sync });
    await flush();
    const retry = purgeBox(el).querySelector("button") as HTMLButtonElement;
    retry.click();
    await flush();
    expect(purgeBox(el).hidden).toBe(false);
    expect(retry.disabled).toBe(false);
    expect(document.activeElement).toBe(retry);
  });

  test("no warning after a clean purge, and none once a new session is signed in", async () => {
    const clean = await signedOutWith([{ ok: true }]);
    expect(purgeBox(setup({ client: clean.client, facade: clean.client.sync }).el).hidden).toBe(true);
    const failed = await signedOutWith([{ ok: false, retryNow: false }]);
    const { el } = setup({ client: failed.client, facade: failed.client.sync });
    await flush();
    expect(purgeBox(el).hidden).toBe(false);
    failed.state.signedIn = true;
    (failed.client.sync as FacadeStub).set({ requested: false, effective: "off" });
    await flush();
    expect(purgeBox(el).hidden).toBe(true);
  });
});

describe("status(ctx)", () => {
  const status = (effective: string) => {
    const { ctx } = setup({ facade: makeFacade(state("off")) });
    const result = ready({ effective: effective as SyncEffective });
    const withLatest = { ...ctx, data: { ...ctx.data, latest: () => result, source: {} } } as unknown as SectionContext;
    return localCopySection.status(withLatest);
  };

  test("On is ok, Off is off, Pending warns", () => {
    expect(status("on")).toEqual({ text: "On", tone: "ok" });
    expect(status("off")).toEqual({ text: "Off", tone: "off" });
    expect(status("pending")).toEqual({ text: "Pending", tone: "warn" });
  });

  test("enabling, wiping and unavailable stay neutral", () => {
    expect(status("enabling")?.tone).toBe("info");
    expect(status("wiping")?.tone).toBe("info");
    expect(status("unavailable")).toEqual({ text: "Unavailable", tone: "info" });
    expect(status("rebooting")?.tone).toBe("info");
  });
});
