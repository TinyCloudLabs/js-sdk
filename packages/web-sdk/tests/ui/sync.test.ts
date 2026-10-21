import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
// Test-only. This deep import reaches into jsdom internals to reach the impl
// of a jsdom event, so it depends on jsdom's file layout. It is pinned to
// jsdom 26.1.0 (exact version in packages/web-sdk/package.json devDependencies).
// Re-check this path whenever jsdom is upgraded. It is not part of the SDK.
import { implSymbol } from "jsdom/lib/jsdom/living/generated/utils.js";

import { syncSection } from "../../src/ui/sections/sync";
import type {
  HostContext,
  PanelClient,
  StatusCode,
  SyncEffective,
  SyncFacade,
  SyncState,
} from "../../src/ui/slots";
import { text } from "../../src/ui/strings";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent"];

let page: Window;
const saved = new Map<string, unknown>();
const cleanups: Array<() => void> = [];

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: `${ORIGIN}/page` }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
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
  let state: SyncState = initial;
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

type HeaderFake = ReturnType<typeof makeHeader>;

/** Header status fake. `set` changes the top status and notifies listeners, as the host board does. */
function makeHeader(initial: StatusCode | null = null) {
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

function makeCtx(facade: SyncFacade | undefined, header: HeaderFake = makeHeader()): HostContext {
  const client = {
    id: 1,
    signedIn: () => true,
    onReset: () => () => undefined,
    sync: facade,
    storage: {},
  } as unknown as PanelClient;
  return {
    client: () => client,
    onClientChange: () => () => undefined,
    developerMode: () => false,
    setStatus: () => undefined,
    topStatus: header.topStatus,
    onStatusChange: header.onStatusChange,
    toast: () => "",
    openPanel: () => undefined,
    closePanel: () => undefined,
    text,
  };
}

function mount(facade: SyncFacade | undefined, header?: HeaderFake) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const dispose = syncSection.mount(el, makeCtx(facade, header));
  cleanups.push(dispose);
  return { el, dispose };
}

// Drain pending promise continuations. The section resolves only through promises, so no timer is needed.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// jsdom makes the wrapper's isTrusted non-configurable and resets it to false
// during dispatch. Pin the impl field to true for trusted clicks; the setter
// ignores jsdom's reset. Untrusted clicks need no change: jsdom dispatches them as untrusted.
function clickEl(target: Element, trusted: boolean): void {
  const ev = new page.MouseEvent("click", { bubbles: true, cancelable: true });
  if (trusted) {
    const impl = (ev as unknown as Record<symbol, object>)[implSymbol];
    Object.defineProperty(impl, "isTrusted", { get: () => true, set: () => {} });
  }
  target.dispatchEvent(ev);
}

const toggleOf = (el: HTMLElement) => el.querySelector("button.switch") as HTMLButtonElement;
const actionButtons = (el: HTMLElement) => el.querySelectorAll("button.action");
const wipeOf = (el: HTMLElement) => actionButtons(el)[0] as HTMLButtonElement;
const confirmOf = (el: HTMLElement) => actionButtons(el)[1] as HTMLButtonElement;
const cancelOf = (el: HTMLElement) => actionButtons(el)[2] as HTMLButtonElement;
const confirmBoxOf = (el: HTMLElement) => el.querySelector(".confirm") as HTMLElement;
const errorOf = (el: HTMLElement) => el.querySelector(".error") as HTMLElement;
const busyOf = (el: HTMLElement) => el.querySelector(".busy") as HTMLElement;
const noteOf = (el: HTMLElement) => el.querySelector(".note") as HTMLElement;

describe("availability", () => {
  test("row is unavailable without tc.sync and available with it", () => {
    const withoutSync = makeCtx(undefined);
    const withSync = makeCtx(makeFacade({ requested: false, effective: "off" }));
    expect(syncSection.isAvailable(withoutSync)).toBe(false);
    expect(syncSection.isAvailable(withSync)).toBe(true);
  });
});

describe("effective states", () => {
  const cases: Array<{
    name: string;
    state: SyncState;
    checked: string;
    disabled: boolean;
    busy?: string;
    note?: string;
  }> = [
    { name: "off", state: { requested: false, effective: "off" }, checked: "false", disabled: false },
    { name: "on", state: { requested: true, effective: "on" }, checked: "true", disabled: false },
    {
      name: "effective on but requested off: switch follows requested",
      state: { requested: false, effective: "on" },
      checked: "false",
      disabled: false,
    },
    {
      name: "enabling",
      state: { requested: true, effective: "enabling" },
      checked: "true",
      disabled: true,
      busy: "sync.busy.enabling",
    },
    {
      name: "wiping",
      state: { requested: true, effective: "wiping" },
      checked: "true",
      disabled: true,
      busy: "sync.busy.wiping",
    },
    {
      name: "pending",
      state: { requested: false, effective: "pending", reason: "erase-pending" },
      checked: "false",
      disabled: true,
      busy: "sync.pending",
      note: "sync.reason.erase-pending",
    },
    {
      name: "unavailable with a reason",
      state: { requested: true, effective: "unavailable", reason: "budget-reached" },
      checked: "true",
      disabled: true,
      busy: "sync.unavailable",
      note: "sync.reason.budget-reached",
    },
  ];

  for (const c of cases) {
    test(`renders ${c.name}`, () => {
      const facade = makeFacade(c.state);
      const { el } = mount(facade);
      expect(toggleOf(el).getAttribute("aria-checked")).toBe(c.checked);
      expect(toggleOf(el).disabled).toBe(c.disabled);
      if (c.busy === undefined) {
        expect(busyOf(el).hidden).toBe(true);
      } else {
        expect(busyOf(el).hidden).toBe(false);
        expect(busyOf(el).textContent).toBe(text(c.busy));
      }
      if (c.note === undefined) {
        expect(noteOf(el).hidden).toBe(true);
      } else {
        expect(noteOf(el).textContent).toBe(text(c.note));
      }
    });
  }

  test("unknown effective value renders as unavailable with the neutral line", () => {
    const facade = makeFacade({
      requested: false,
      effective: "exploded" as SyncEffective,
      reason: "budget-reached",
    });
    const { el } = mount(facade);
    expect(busyOf(el).textContent).toBe(text("sync.unavailable"));
    expect(noteOf(el).textContent).toBe(text("sync.reason.unknown"));
    expect(el.textContent).not.toContain("exploded");
  });

  test("unknown reason renders the neutral line and never the raw code", () => {
    const facade = makeFacade({ requested: false, effective: "pending", reason: "made-up-xyz" });
    const { el } = mount(facade);
    expect(noteOf(el).textContent).toBe(text("sync.reason.unknown"));
    expect(el.textContent).not.toContain("made-up-xyz");
  });
});

describe("pending word and header status", () => {
  const pending: SyncState = { requested: false, effective: "pending", reason: "erase-pending" };

  test("hides the busy word while the header shows the same status", () => {
    const { el } = mount(makeFacade(pending), makeHeader("sync_pending"));
    expect(busyOf(el).hidden).toBe(true);
    expect(noteOf(el).textContent).toBe(text("sync.reason.erase-pending"));
  });

  test("shows the busy word when the header shows a different status", () => {
    const { el } = mount(makeFacade(pending), makeHeader("storage_full"));
    expect(busyOf(el).hidden).toBe(false);
    expect(busyOf(el).textContent).toBe(text("sync.pending"));
  });

  test("follows header status changes while mounted", () => {
    const header = makeHeader("sync_pending");
    const { el } = mount(makeFacade(pending), header);
    header.set("storage_full");
    expect(busyOf(el).hidden).toBe(false);
    header.set("sync_pending");
    expect(busyOf(el).hidden).toBe(true);
  });
});

describe("wipe note placement", () => {
  const on: SyncState = { requested: true, effective: "on" };

  test("sits directly under the wipe button in the default on state", () => {
    const { el } = mount(makeFacade(on));
    const note = wipeOf(el).nextElementSibling as HTMLElement;
    expect(note.textContent).toBe(text("sync.wipe.note"));
    expect(note.hidden).toBe(false);
  });

  test("is shown once while confirming", () => {
    const { el } = mount(makeFacade(on));
    clickEl(wipeOf(el), true);
    const notes = [...el.querySelectorAll<HTMLElement>(".note")].filter((n) => n.textContent === text("sync.wipe.note"));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.hidden).toBe(false);
  });
});

describe("switch", () => {
  test("untrusted click is ignored", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el } = mount(facade);
    clickEl(toggleOf(el), false);
    await flush();
    expect(facade.setEnabledCalls).toEqual([]);
  });

  test("trusted click on an off switch enables sync", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el } = mount(facade);
    clickEl(toggleOf(el), true);
    await flush();
    expect(facade.setEnabledCalls).toEqual([true]);
  });

  test("trusted click on an on switch disables sync", async () => {
    const facade = makeFacade({ requested: true, effective: "on" });
    const { el } = mount(facade);
    clickEl(toggleOf(el), true);
    await flush();
    expect(facade.setEnabledCalls).toEqual([false]);
  });

  test("trusted click on a disabled switch is ignored", async () => {
    const facade = makeFacade({ requested: true, effective: "enabling" });
    const { el } = mount(facade);
    clickEl(toggleOf(el), true);
    await flush();
    expect(facade.setEnabledCalls).toEqual([]);
  });

  test("subscription updates the row when the facade state changes", () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el } = mount(facade);
    facade.set({ requested: true, effective: "on" });
    expect(toggleOf(el).getAttribute("aria-checked")).toBe("true");
  });

  test("declined enable shows the declined line", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    facade.nextSetEnabled = () => Promise.reject({ code: "declined" });
    const { el } = mount(facade);
    clickEl(toggleOf(el), true);
    await flush();
    expect(errorOf(el).textContent).toBe(text("sync.error.declined"));
    expect(toggleOf(el).disabled).toBe(false);
  });

  test("unknown error code renders the neutral line and never the raw code", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    facade.nextSetEnabled = () => Promise.reject({ code: "weird-code" });
    const { el } = mount(facade);
    clickEl(toggleOf(el), true);
    await flush();
    expect(errorOf(el).textContent).toBe(text("sync.reason.unknown"));
    expect(el.textContent).not.toContain("weird-code");
  });
});

describe("wipe", () => {
  test("untrusted wipe click does not open the confirm", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el } = mount(facade);
    clickEl(wipeOf(el), false);
    await flush();
    expect(confirmBoxOf(el).hidden).toBe(true);
    expect(facade.wipeCalls).toBe(0);
  });

  test("trusted wipe click opens the confirm without wiping yet", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el } = mount(facade);
    clickEl(wipeOf(el), true);
    await flush();
    expect(confirmBoxOf(el).hidden).toBe(false);
    expect(facade.wipeCalls).toBe(0);
  });

  test("cancel hides the confirm and does not wipe", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el } = mount(facade);
    clickEl(wipeOf(el), true);
    clickEl(cancelOf(el), true);
    await flush();
    expect(confirmBoxOf(el).hidden).toBe(true);
    expect(facade.wipeCalls).toBe(0);
  });

  test("untrusted confirm click does not wipe", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el } = mount(facade);
    clickEl(wipeOf(el), true);
    clickEl(confirmOf(el), false);
    await flush();
    expect(facade.wipeCalls).toBe(0);
    expect(confirmBoxOf(el).hidden).toBe(false);
  });

  test("trusted confirm wipes once and closes the confirm", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el } = mount(facade);
    clickEl(wipeOf(el), true);
    clickEl(confirmOf(el), true);
    await flush();
    expect(facade.wipeCalls).toBe(1);
    expect(confirmBoxOf(el).hidden).toBe(true);
  });

  test("wipe is visible while sync is on", () => {
    const facade = makeFacade({ requested: true, effective: "on" });
    const { el } = mount(facade);
    expect(wipeOf(el).disabled).toBe(false);
  });

  test("wipe is disabled while enabling or wiping", () => {
    const enabling = mount(makeFacade({ requested: true, effective: "enabling" }));
    const wiping = mount(makeFacade({ requested: true, effective: "wiping" }));
    expect(wipeOf(enabling.el).disabled).toBe(true);
    expect(wipeOf(wiping.el).disabled).toBe(true);
  });

  test("failed wipe shows the failed line and keeps the confirm open", async () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    facade.nextWipe = () => Promise.reject({ code: "failed" });
    const { el } = mount(facade);
    clickEl(wipeOf(el), true);
    clickEl(confirmOf(el), true);
    await flush();
    expect(errorOf(el).textContent).toBe(text("sync.error.failed"));
    expect(confirmBoxOf(el).hidden).toBe(false);
  });
});

describe("dispose", () => {
  test("unsubscribes and ignores later changes", () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el, dispose } = mount(facade);
    dispose();
    expect(facade.listenerCount()).toBe(0);
    facade.set({ requested: false, effective: "pending" });
    expect(el.childElementCount).toBe(0);
  });
});
