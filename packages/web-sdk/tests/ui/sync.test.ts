import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

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
  page = new Window({ url: `${ORIGIN}/page` });
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

function makeCtx(facade: SyncFacade | undefined, statuses: Array<StatusCode | null>): HostContext {
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
    setStatus: (source, status) => {
      if (source === "sync") statuses.push(status);
    },
    toast: () => "",
    openPanel: () => undefined,
    closePanel: () => undefined,
    text,
  };
}

function mount(facade: SyncFacade | undefined) {
  const statuses: Array<StatusCode | null> = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const dispose = syncSection.mount(el, makeCtx(facade, statuses));
  cleanups.push(dispose);
  return { el, statuses, dispose };
}

// Drain pending promise continuations. The section resolves only through promises, so no timer is needed.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function clickEl(target: Element, trusted: boolean): void {
  const ev = new page.MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "isTrusted", { value: trusted });
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
    const withoutSync = makeCtx(undefined, []);
    const withSync = makeCtx(makeFacade({ requested: false, effective: "off" }), []);
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
    { name: "off", state: { requested: false, effective: "off" }, checked: "false", disabled: false, busy: "sync.state.off" },
    { name: "on", state: { requested: true, effective: "on" }, checked: "true", disabled: false, busy: "sync.state.on" },
    {
      name: "effective on but requested off: switch follows requested",
      state: { requested: false, effective: "on" },
      checked: "false",
      disabled: false,
      busy: "sync.state.off",
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

describe("status", () => {
  const cases: Array<{ name: string; state: SyncState; status: StatusCode | null }> = [
    { name: "off", state: { requested: false, effective: "off" }, status: null },
    { name: "on", state: { requested: true, effective: "on" }, status: null },
    { name: "enabling", state: { requested: true, effective: "enabling" }, status: null },
    { name: "wiping", state: { requested: true, effective: "wiping" }, status: null },
    { name: "pending", state: { requested: false, effective: "pending" }, status: "sync_pending" },
    {
      name: "unavailable while requested",
      state: { requested: true, effective: "unavailable" },
      status: "sync_attention",
    },
    {
      name: "unavailable while not requested",
      state: { requested: false, effective: "unavailable" },
      status: null,
    },
    {
      name: "unknown effective while requested",
      state: { requested: true, effective: "exploded" as SyncEffective },
      status: "sync_attention",
    },
  ];

  for (const c of cases) {
    test(`publishes ${c.status ?? "no status"} for ${c.name}`, () => {
      const { statuses } = mount(makeFacade(c.state));
      expect(statuses.at(-1)).toBe(c.status);
    });
  }
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
  test("unsubscribes, clears the status, and ignores later changes", () => {
    const facade = makeFacade({ requested: false, effective: "off" });
    const { el, statuses, dispose } = mount(facade);
    dispose();
    expect(facade.listenerCount()).toBe(0);
    expect(statuses.at(-1)).toBe(null);
    const before = statuses.length;
    facade.set({ requested: false, effective: "pending" });
    expect(statuses.length).toBe(before);
    expect(el.childElementCount).toBe(0);
  });
});
