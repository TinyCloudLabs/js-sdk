import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { registerUiClient, type UiClientHandle } from "../../src/ui";
import type { ClientSource } from "../../src/ui/client";
import { createHostRuntime, HOST_API_VERSION, REGISTRY_KEY } from "../../src/ui/host";
import { HIDE_KEY_PREFIX } from "../../src/ui/persistence";
import { text } from "../../src/ui/strings";
import type { HostContext, SyncFacade, SyncState } from "../../src/ui/slots";
import { toastStore, toasts } from "../../src/ui/parts/toasts";
import { mountPrompt } from "../../src/ui/parts/prompts";
import type { ToastView } from "../../src/ui/toast-store";
import type { UiPosition } from "../../src/ui/config";
import { panelMounted } from "./panel-ready";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
const GLOBAL_NAMES = ["window", "document", "location", "localStorage", "HTMLElement", "Element", "Event", "KeyboardEvent", "matchMedia"];

let page: Window;
const saved = new Map<string, unknown>();

// jsdom makes window.top and window.location unforgeable. Framed and
// opaque-origin tests override them through this view of the global window.
const overrides = new Map<PropertyKey, unknown>();
let view: Window;

type PhoneListener = (event: MediaQueryListEvent) => void;
// jsdom has no matchMedia. The stub holds one phone flag and notifies listeners on change.
let phoneMatch = false;
let phoneListeners = new Set<PhoneListener>();

function setPhone(next: boolean): void {
  phoneMatch = next;
  for (const listener of [...phoneListeners]) listener({ matches: next } as MediaQueryListEvent);
}

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: `${ORIGIN}/page` }).window as unknown as Window;
  view = new Proxy(page, {
    get(target, prop) {
      if (overrides.has(prop)) return overrides.get(prop);
      if (prop === "top") return view;
      const value = Reflect.get(target, prop, target);
      // Methods need the real window as `this`; constructors are returned as-is.
      return typeof value === "function" && !/^[A-Z]/.test(String(prop)) ? value.bind(target) : value;
    },
  });
  g.window = view;
  g.document = page.document;
  g.location = page.location;
  g.localStorage = page.localStorage;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.KeyboardEvent = page.KeyboardEvent;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

beforeEach(() => {
  delete g[REGISTRY_KEY];
  page.document.body.innerHTML = "";
  page.localStorage.clear();
  phoneMatch = false;
  phoneListeners = new Set();
  g.matchMedia = (query: string) => ({
    media: query,
    get matches() {
      return phoneMatch;
    },
    addEventListener: (_type: string, listener: PhoneListener) => {
      phoneListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: PhoneListener) => {
      phoneListeners.delete(listener);
    },
  });
});

afterEach(() => {
  overrides.clear();
});

function source(signedIn = false): ClientSource {
  return { signedIn: () => signedIn, storage: { status: () => undefined } } as unknown as ClientSource;
}

function mountClient(ui?: Parameters<typeof registerUiClient>[0]["ui"], signedIn = false): UiClientHandle {
  return registerUiClient({ ui, source: source(signedIn), manifestAppId: () => undefined });
}

function hostEl(): HTMLElement | null {
  return page.document.querySelector("[data-tinycloud-ui]") as HTMLElement | null;
}

function hostState(): string | null {
  return hostEl()?.getAttribute("data-tinycloud-ui") ?? null;
}

function shadow(): ShadowRoot {
  const root = hostEl()?.shadowRoot;
  if (!root) throw new Error("no open shadow root on the TinyCloud host");
  return root;
}

function buttonEl(): HTMLButtonElement | null {
  return shadow().querySelector("button[aria-controls]") as HTMLButtonElement | null;
}

function actionEl(label: string): HTMLButtonElement | undefined {
  return [...shadow().querySelectorAll("button.action")].find(
    (el) => el.textContent === label,
  ) as HTMLButtonElement | undefined;
}

function hideKey(): string {
  return `${HIDE_KEY_PREFIX}${encodeURIComponent(ORIGIN)}:_page`;
}

function overrideWindowProp(name: "top" | "location", value: unknown): void {
  overrides.set(name, value);
}

describe("host mount", () => {
  test("mounts one open host at z-index 999990", () => {
    mountClient();
    expect(hostEl()).not.toBeNull();
    expect(hostEl()?.shadowRoot).not.toBeNull();
    expect(hostEl()?.style.zIndex).toBe("999990");
    expect(hostState()).toBe("closed");
    expect(page.document.querySelectorAll("[data-tinycloud-ui]").length).toBe(1);
  });

  test("shadow tree contains no dialog or popover markup", () => {
    mountClient();
    const root = shadow();
    expect(root.querySelector("dialog")).toBeNull();
    expect(root.querySelector("[popover]")).toBeNull();
  });

  test("adds no string-keyed global and only the registry symbol", () => {
    const namesBefore = Object.getOwnPropertyNames(globalThis);
    const pageNamesBefore = Object.getOwnPropertyNames(page);
    const symbolsBefore = new Set(Object.getOwnPropertySymbols(globalThis));

    const ui = mountClient();
    ui.api.open();
    ui.api.close();

    const newNames = Object.getOwnPropertyNames(globalThis).filter((name) => !namesBefore.includes(name));
    const newPageNames = Object.getOwnPropertyNames(page).filter((name) => !pageNamesBefore.includes(name));
    const newSymbols = Object.getOwnPropertySymbols(globalThis).filter((sym) => !symbolsBefore.has(sym));
    expect(newNames).toEqual([]);
    expect(newPageNames).toEqual([]);
    expect(newSymbols).toEqual([REGISTRY_KEY]);
  });

  test("one host is shared by two clients; unregistering the last removes it", () => {
    const a = mountClient();
    const b = mountClient();
    expect(page.document.querySelectorAll("[data-tinycloud-ui]").length).toBe(1);
    a.unregister();
    expect(hostEl()).not.toBeNull();
    b.unregister();
    expect(hostEl()).toBeNull();
  });

  test("reset keeps the host mounted", () => {
    const a = mountClient();
    a.reset();
    expect(hostEl()).not.toBeNull();
  });

  test("a second copy with another apiVersion mounts nothing and warns once", () => {
    g[REGISTRY_KEY] = { apiVersion: 2, runtime: undefined };
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const first = mountClient();
      const second = mountClient();
      expect(first.api.available).toBe(false);
      expect(second.api.available).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
    expect(hostEl()).toBeNull();
    expect(warnings).toEqual([["[tinycloud] ui-host-version-mismatch"]]);
  });
});

describe("prompts are settled by the client that opened them", () => {
  // Stands in for a prompt: mounts into the host layer and counts dismissals.
  function openPrompt(handle: UiClientHandle, dismissed: { count: number }): void {
    const el = page.document.createElement("div");
    const mounted = mountPrompt(handle.promptScope, el, () => {
      el.remove();
      dismissed.count += 1;
    });
    if ("refusal" in mounted) throw new Error(`prompt refused: ${mounted.refusal}`);
  }

  test("reset settles only the resetting client's prompts", () => {
    const a = mountClient();
    const b = mountClient();
    const aPrompt = { count: 0 };
    const bPrompt = { count: 0 };
    openPrompt(a, aPrompt);
    openPrompt(b, bPrompt);

    a.reset();
    expect(aPrompt.count).toBe(1);
    expect(bPrompt.count).toBe(0);

    b.reset();
    expect(bPrompt.count).toBe(1);
  });

  test("unregister settles only that client's prompts and keeps the host for the other client", () => {
    const a = mountClient();
    const b = mountClient();
    const aPrompt = { count: 0 };
    const bPrompt = { count: 0 };
    openPrompt(a, aPrompt);
    openPrompt(b, bPrompt);

    a.unregister();
    expect(aPrompt.count).toBe(1);
    expect(bPrompt.count).toBe(0);
    expect(hostEl()).not.toBeNull();

    b.unregister();
    expect(bPrompt.count).toBe(1);
    expect(hostEl()).toBeNull();
  });
});

describe("open, close, hide", () => {
  test("open clears the hidden flag and shows the button", () => {
    page.localStorage.setItem(hideKey(), "1");
    const ui = mountClient();
    expect(hostState()).toBe("hidden");
    ui.api.open();
    expect(hostState()).toBe("open");
    expect(page.localStorage.getItem(hideKey())).toBeNull();
    expect(ui.api.isOpen).toBe(true);
  });

  test("the panel hide control sets the flag and closes", async () => {
    const ui = mountClient();
    ui.api.open();
    await panelMounted();
    actionEl(text("panel.hide"))?.click();
    expect(page.localStorage.getItem(hideKey())).toBe("1");
    expect(hostState()).toBe("hidden");
    expect(ui.api.isOpen).toBe(false);
  });

  test("close never changes the hidden flag", async () => {
    const ui = mountClient();
    ui.api.open();
    await panelMounted();
    actionEl(text("panel.hide"))?.click();
    ui.api.close();
    expect(page.localStorage.getItem(hideKey())).toBe("1");
    expect(hostState()).toBe("hidden");
  });

  test("the floating button toggles the panel", () => {
    const ui = mountClient();
    buttonEl()?.click();
    expect(ui.api.isOpen).toBe(true);
    buttonEl()?.click();
    expect(ui.api.isOpen).toBe(false);
  });

  test("Escape on the panel element closes it", async () => {
    const ui = mountClient();
    ui.api.open();
    await panelMounted();
    const panel = shadow().querySelector("[role='dialog']") as HTMLElement;
    panel.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(ui.api.isOpen).toBe(false);
  });

  test("the layer carries data-panel-open only while the panel is open", async () => {
    const ui = mountClient();
    const layer = () => shadow().querySelector(".layer") as HTMLElement;
    expect(layer().hasAttribute("data-panel-open")).toBe(false);
    ui.api.open();
    await panelMounted();
    expect(layer().hasAttribute("data-panel-open")).toBe(true);
    buttonEl()?.click();
    expect(layer().hasAttribute("data-panel-open")).toBe(false);
  });
});

describe("phone layout", () => {
  const layer = () => shadow().querySelector(".layer") as HTMLElement;
  const closeButton = () => shadow().querySelector("button[aria-label='Close']") as HTMLButtonElement | null;
  const navItems = () => [...shadow().querySelectorAll<HTMLButtonElement>(".nav-i")];

  test("phones open the full page, never the drawer", async () => {
    setPhone(true);
    const ui = mountClient();
    ui.api.open();
    await panelMounted();
    expect(layer().getAttribute("data-layout")).toBe("page");
    expect(layer().hasAttribute("data-phone")).toBe(true);
    expect(ui.api.isOpen).toBe(true);
  });

  test("the launcher opens the full page on phones", async () => {
    setPhone(true);
    const ui = mountClient();
    buttonEl()?.click();
    await panelMounted();
    expect(ui.api.isOpen).toBe(true);
    expect(layer().getAttribute("data-layout")).toBe("page");
  });

  test("a phone close control closes the page", async () => {
    setPhone(true);
    const ui = mountClient();
    ui.api.open();
    await panelMounted();
    closeButton()?.click();
    expect(ui.api.isOpen).toBe(false);
  });

  test("Escape closes the page on a phone", async () => {
    setPhone(true);
    const ui = mountClient();
    ui.api.open();
    await panelMounted();
    const panel = shadow().querySelector("[role='dialog']") as HTMLElement;
    panel.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(ui.api.isOpen).toBe(false);
  });

  test("a breakpoint crossing keeps open state and section", async () => {
    const ui = mountClient();
    ui.api.open();
    await panelMounted();
    navItems()[1]?.click();
    setPhone(true);
    expect(ui.api.isOpen).toBe(true);
    expect(layer().getAttribute("data-layout")).toBe("page");
    expect(navItems()[1]?.getAttribute("aria-current")).toBe("page");
    setPhone(false);
    expect(ui.api.isOpen).toBe(true);
    expect(layer().getAttribute("data-layout")).toBe("drawer");
    expect(navItems()[1]?.getAttribute("aria-current")).toBe("page");
  });

  test("leaving the phone breakpoint with the panel closed stays closed", () => {
    setPhone(true);
    const ui = mountClient();
    setPhone(false);
    expect(ui.api.isOpen).toBe(false);
    expect(layer()?.hasAttribute("data-phone")).toBe(false);
  });

  describe("section menu", () => {
    const menuButton = () => shadow().querySelector(".menu-btn") as HTMLButtonElement;
    const menuPanel = () => shadow().querySelector(".menu") as HTMLElement;
    const menuItems = () => [...shadow().querySelectorAll<HTMLButtonElement>(".menu-i")];

    test("the menu button is labelled, controls the menu, and reports its state", async () => {
      setPhone(true);
      const ui = mountClient();
      ui.api.open();
      await panelMounted();
      expect(menuButton().getAttribute("aria-label")).toBe("Sections");
      expect(menuButton().getAttribute("aria-controls")).toBe(menuPanel().id);
      expect(menuButton().getAttribute("aria-expanded")).toBe("false");
      expect(menuPanel().hidden).toBe(true);
      menuButton().click();
      expect(menuButton().getAttribute("aria-expanded")).toBe("true");
      expect(menuPanel().hidden).toBe(false);
    });

    test("choosing a section closes the menu, marks it current, and focuses its heading", async () => {
      setPhone(true);
      const ui = mountClient();
      ui.api.open();
      await panelMounted();
      menuButton().click();
      menuItems()[1]?.click();
      expect(menuPanel().hidden).toBe(true);
      expect(menuButton().getAttribute("aria-expanded")).toBe("false");
      expect(menuItems()[1]?.getAttribute("aria-current")).toBe("page");
      expect(navItems()[1]?.getAttribute("aria-current")).toBe("page");
      expect(shadow().activeElement?.classList.contains("sec-title")).toBe(true);
    });

    test("Escape closes the menu first, then the page", async () => {
      setPhone(true);
      const ui = mountClient();
      ui.api.open();
      await panelMounted();
      menuButton().click();
      const panel = shadow().querySelector("[role='dialog']") as HTMLElement;
      panel.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
      expect(menuPanel().hidden).toBe(true);
      expect(shadow().activeElement).toBe(menuButton());
      expect(ui.api.isOpen).toBe(true);
      panel.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
      expect(ui.api.isOpen).toBe(false);
    });

    test("crossing back to desktop closes the menu", async () => {
      setPhone(true);
      const ui = mountClient();
      ui.api.open();
      await panelMounted();
      menuButton().click();
      setPhone(false);
      expect(menuPanel().hidden).toBe(true);
      expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    });
  });
});

describe("headless modes", () => {
  test("ui:false creates no host and every method is a silent no-op", () => {
    const ui = mountClient(false);
    expect(hostEl()).toBeNull();
    ui.api.open();
    ui.api.toggle();
    ui.api.close();
    expect(ui.api.available).toBe(false);
    expect(ui.api.isOpen).toBe(false);
    expect(hostEl()).toBeNull();
  });

  test("ui.button:false renders no button and no hide control, and open still works", () => {
    const ui = mountClient({ button: false });
    expect(buttonEl()).toBeNull();
    ui.api.open();
    expect(ui.api.isOpen).toBe(true);
    expect(actionEl(text("panel.hide"))).toBeUndefined();
    expect(page.localStorage.getItem(hideKey())).toBeNull();
  });
});

describe("ui.position placement", () => {
  // Every accepted value, plus one unknown value that falls back to bottom-right.
  const PLACEMENTS: ReadonlyArray<readonly [string, string]> = [
    ["top-right", "bottom-right"],
    ["top-left", "bottom-left"],
    ["top-center", "bottom-center"],
    ["bottom-right", "bottom-right"],
    ["bottom-left", "bottom-left"],
    ["bottom-center", "bottom-center"],
    ["sideways", "bottom-right"],
  ];

  for (const [requested, placed] of PLACEMENTS) {
    test(`${requested} places the button and toast stack in the ${placed} layer`, () => {
      mountClient({ position: requested as UiPosition });
      const layer = shadow().querySelector(".layer");
      expect(layer?.getAttribute("data-position")).toBe(placed);
      expect(layer?.contains(buttonEl())).toBe(true);
      expect(layer?.querySelector(".toasts")).not.toBeNull();
    });
  }
});

describe("frame and opaque-origin refusal", () => {
  test("an iframe at register creates no host and reports available false", () => {
    overrideWindowProp("top", {});
    const ui = mountClient();
    expect(hostEl()).toBeNull();
    expect(ui.api.available).toBe(false);
    ui.api.open();
    expect(ui.api.isOpen).toBe(false);
  });

  test("an opaque origin at register creates no host", () => {
    overrideWindowProp("location", { origin: "null" });
    const ui = mountClient();
    expect(hostEl()).toBeNull();
    expect(ui.api.available).toBe(false);
  });

  test("open() is refused after the page becomes framed", () => {
    const ui = mountClient();
    expect(ui.api.available).toBe(true);
    overrideWindowProp("top", {});
    ui.api.open();
    expect(ui.api.isOpen).toBe(false);
    expect(hostState()).toBe("closed");
  });
});

describe("sync status on the button while the panel is closed", () => {
  function syncStub(initial: SyncState) {
    let state = initial;
    const listeners = new Set<() => void>();
    const facade: SyncFacade = {
      get state() {
        return state;
      },
      subscribe(cb) {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      setEnabled: async () => undefined,
      wipeLocalData: async () => undefined,
    };
    return {
      facade,
      set(next: SyncState) {
        state = next;
        for (const cb of [...listeners]) cb();
      },
    };
  }

  function mountWithSync(facade: SyncFacade): UiClientHandle {
    const src = { signedIn: () => false, storage: { status: () => undefined }, sync: facade } as unknown as ClientSource;
    return registerUiClient({ source: src, manifestAppId: () => undefined });
  }

  function dotEl(): HTMLElement | null {
    return buttonEl()?.querySelector(".dot") as HTMLElement | null;
  }

  test("pending shows the dot with sync_pending while the panel is closed", () => {
    const sync = syncStub({ requested: false, effective: "pending" });
    const ui = mountWithSync(sync.facade);
    expect(ui.api.isOpen).toBe(false);
    expect(dotEl()?.hidden).toBe(false);
    expect(dotEl()?.getAttribute("data-status")).toBe("sync_pending");
  });

  test("unavailable while requested shows the dot with sync_attention", () => {
    const sync = syncStub({ requested: true, effective: "unavailable" });
    mountWithSync(sync.facade);
    expect(dotEl()?.getAttribute("data-status")).toBe("sync_attention");
  });

  test("a facade change updates the dot and clears it when no status applies", () => {
    const sync = syncStub({ requested: false, effective: "pending" });
    mountWithSync(sync.facade);
    sync.set({ requested: false, effective: "off" });
    expect(dotEl()?.hidden).toBe(true);
    expect(dotEl()?.hasAttribute("data-status")).toBe(false);
  });

  test("unregistering the last client removes the host and its dot", () => {
    const sync = syncStub({ requested: false, effective: "pending" });
    const ui = mountWithSync(sync.facade);
    const dot = dotEl();
    ui.unregister();
    expect(hostEl()).toBeNull();
    expect(dot?.isConnected).toBe(false);
  });
});

describe("messaging and dialog HARD rules", () => {
  // Spies stay installed for each test in this block, so every mount, open,
  // click, and unregister runs under them.
  const FORBIDDEN = ["message", "messageerror", "storage"];
  type Listener = { target: string; type: string };
  type Spy = { calls: string[]; listeners: Listener[] };
  const undo: Array<() => void> = [];
  let spy: Spy;

  function define(target: object, name: PropertyKey, descriptor: PropertyDescriptor): void {
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, ...descriptor });
    undo.push(() => {
      if (original) Object.defineProperty(target, name, original);
      else Reflect.deleteProperty(target, name);
    });
  }

  function installSpies(): Spy {
    const next: Spy = { calls: [], listeners: [] };
    const roots: Array<[string, Loose]> = [
      ["globalThis", g],
      ["window", page as unknown as Loose],
      ["document", page.document as unknown as Loose],
    ];
    for (const [label, target] of roots) {
      const realAdd = target.addEventListener as (...a: unknown[]) => unknown;
      define(target, "addEventListener", {
        writable: true,
        value(this: unknown, type: unknown, ...rest: unknown[]) {
          next.listeners.push({ target: label, type: String(type) });
          return realAdd.apply(this, [type, ...rest]);
        },
      });
    }
    for (const [label, target] of roots.slice(0, 2)) {
      for (const ctor of ["BroadcastChannel", "MessageChannel"]) {
        define(target, ctor, {
          writable: true,
          value: function stub() {
            next.calls.push(`${label}.${ctor}`);
          },
        });
      }
      define(target, "postMessage", {
        writable: true,
        value: () => {
          next.calls.push(`${label}.postMessage`);
        },
      });
      let handler: unknown = null;
      define(target, "onmessage", {
        get: () => handler,
        set: (value: unknown) => {
          next.calls.push(`${label}.onmessage`);
          handler = value;
        },
      });
    }
    return next;
  }

  function installDialogSpies(): void {
    const dialogProto = page.HTMLDialogElement.prototype as unknown as object;
    define(dialogProto, "showModal", {
      writable: true,
      value: () => {
        spy.calls.push("showModal");
      },
    });
    for (const name of ["showPopover", "hidePopover", "togglePopover"]) {
      define(page.HTMLElement.prototype, name, {
        writable: true,
        value: () => {
          spy.calls.push(name);
        },
      });
    }
  }

  function forbiddenListeners(): Listener[] {
    return spy.listeners.filter((listener) => FORBIDDEN.includes(listener.type));
  }

  beforeEach(() => {
    spy = installSpies();
  });

  afterEach(() => {
    while (undo.length) undo.pop()?.();
  });

  test("default config: no BroadcastChannel, MessageChannel, postMessage, onmessage, or message listener", () => {
    const ui = mountClient();
    ui.api.open();
    buttonEl()?.click();
    ui.api.close();
    ui.unregister();
    expect(spy.calls).toEqual([]);
    expect(forbiddenListeners()).toEqual([]);
  });

  test("ui:false: no host and no listeners of any type on globalThis, window, or document", () => {
    const ui = mountClient(false);
    ui.api.open();
    ui.api.close();
    expect(hostEl()).toBeNull();
    expect(spy.calls).toEqual([]);
    expect(spy.listeners).toEqual([]);
  });

  test("framed: open is refused and no messaging API is touched", () => {
    overrideWindowProp("top", {});
    const ui = mountClient();
    ui.api.open();
    expect(ui.api.isOpen).toBe(false);
    expect(hostEl()).toBeNull();
    expect(spy.calls).toEqual([]);
    expect(forbiddenListeners()).toEqual([]);
  });

  test("no showModal, showPopover, togglePopover, or hidePopover, and no dialog or popover markup", () => {
    expect(page.HTMLDialogElement).toBeDefined();
    installDialogSpies();
    const ui = mountClient();
    ui.api.open();
    actionEl(text("panel.hide"))?.click();
    expect(spy.calls).toEqual([]);
    expect(shadow().querySelector("dialog, [popover]")).toBeNull();
    expect(page.document.querySelector("dialog, [popover]")).toBeNull();
  });
});

describe("host toasts", () => {
  const UNEXPECTED = text("toast.unexpected_error");
  const REQUEST = { kind: "error", textCode: "toast.space_creation_failed" } as const;

  function storedToasts(): readonly ToastView[] {
    let current: readonly ToastView[] = [];
    toastStore.subscribe((toasts) => {
      current = toasts;
    })();
    return current;
  }

  function clearToasts(): void {
    for (const toast of storedToasts()) toastStore.dismiss(toast.id);
  }

  function rejection(reason: unknown): Event {
    const NativeEvent = saved.get("Event") as typeof Event;
    return Object.assign(new NativeEvent("unhandledrejection"), { reason });
  }

  beforeEach(clearToasts);

  test("an SDK rejection shows the fixed unexpected-error copy in the mounted host", () => {
    mountClient();
    globalThis.dispatchEvent(rejection(new Error("TinyCloud storage failed")));
    expect(shadow().textContent).toContain(UNEXPECTED);
  });

  test("a rejection without a TinyCloud message is ignored", () => {
    mountClient();
    globalThis.dispatchEvent(rejection({ message: "unrelated" }));
    expect(storedToasts()).toEqual([]);
  });

  test("the rejection listener survives reset and stops after the last unregister", () => {
    const ui = mountClient();
    ui.reset();
    globalThis.dispatchEvent(rejection(new Error("TinyCloud storage failed")));
    expect(storedToasts().length).toBe(1);
    ui.unregister();
    clearToasts();
    globalThis.dispatchEvent(rejection(new Error("TinyCloud storage failed")));
    expect(storedToasts()).toEqual([]);
  });

  test("toast shows a request through the host and returns true", () => {
    const ui = mountClient();
    expect(ui.toast(REQUEST)).toBe(true);
    expect(shadow().textContent).toContain(text(REQUEST.textCode));
  });

  test("identical visible requests store one toast", () => {
    const ui = mountClient();
    ui.toast(REQUEST);
    ui.toast(REQUEST);
    expect(storedToasts().length).toBe(1);
  });

  test("a headless client returns false and stores nothing", () => {
    const ui = mountClient(false);
    expect(ui.toast(REQUEST)).toBe(false);
    expect(storedToasts()).toEqual([]);
  });

  test("a framed page returns false and stores nothing", () => {
    overrideWindowProp("top", {});
    const ui = mountClient();
    expect(ui.toast(REQUEST)).toBe(false);
    expect(storedToasts()).toEqual([]);
  });

  test("an unregistered client returns false and stores nothing", () => {
    const ui = mountClient();
    ui.unregister();
    expect(ui.toast(REQUEST)).toBe(false);
    expect(storedToasts()).toEqual([]);
  });

  test("reset clears only this client's toasts", () => {
    const a = mountClient();
    const b = mountClient();
    a.toast(REQUEST);
    b.toast({ kind: "info", textCode: "toast.done" });
    a.reset();
    expect(storedToasts().map((toast) => toast.textCode)).toEqual(["toast.done"]);
    a.unregister();
    b.unregister();
  });

  test("ui.button:false still shows toasts", () => {
    const ui = mountClient({ button: false });
    expect(ui.toast({ kind: "info", textCode: "toast.done" })).toBe(true);
    expect(storedToasts().map((toast) => toast.textCode)).toEqual(["toast.done"]);
    expect(buttonEl()).toBeNull();
    ui.unregister();
  });

  test("ui.toasts:false shows no rejection toast and keeps the button", () => {
    const ui = mountClient({ toasts: false });
    globalThis.dispatchEvent(rejection(new Error("TinyCloud storage failed")));
    expect(storedToasts()).toEqual([]);
    expect(buttonEl()).not.toBeNull();
    ui.unregister();
  });

  test("ui.toasts:false makes toast return false and store nothing", () => {
    const ui = mountClient({ toasts: false });
    expect(ui.toast(REQUEST)).toBe(false);
    expect(storedToasts()).toEqual([]);
    ui.unregister();
  });

  // The toast waits on one status read; a few microtask turns settle it without timers.
  async function flushToasts(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  test("ui.toasts:false hides the storage-full toast but keeps the full state on the button", async () => {
    const ui = mountStorageFull({ toasts: false });
    await flushToasts();
    expect(storedToasts()).toEqual([]);
    expect(storageStatus()).toBe("storage_full");
    ui.unregister();
  });

  test("storage-full toast is shown when toasts are enabled (control for the test above)", async () => {
    const ui = mountStorageFull(undefined);
    await flushToasts();
    expect(storedToasts().map((view) => view.textCode)).toEqual(["storage.full"]);
    expect(storageStatus()).toBe("storage_full");
    ui.unregister();
  });

  function mountStorageFull(ui: Parameters<typeof registerUiClient>[0]["ui"]): UiClientHandle {
    const storageEpisode = {
      current: () => ({}),
      subscribe: () => () => undefined,
      subscribeDelegated: () => () => undefined,
    };
    const src = {
      signedIn: () => false,
      storage: { status: () => undefined },
      storageEpisode,
    } as unknown as ClientSource;
    return registerUiClient({ ui, source: src, manifestAppId: () => undefined });
  }

  function storageStatus(): string | null {
    return buttonEl()?.querySelector("[data-status]")?.getAttribute("data-status") ?? null;
  }

  // Parts receive the HostContext when the host mounts. The toasts part starts
  // first among the host parts, so wrap its start to capture that context.
  function captureHostContext(): { context: () => HostContext | undefined; restore: () => void } {
    let captured: HostContext | undefined;
    const original = toasts.start;
    toasts.start = (ctx, layer) => {
      captured = ctx;
      return original.call(toasts, ctx, layer);
    };
    return {
      context: () => captured,
      restore: () => {
        toasts.start = original;
      },
    };
  }

  test("HostContext.toast under ui.toasts:false returns null and stores nothing", () => {
    const probe = captureHostContext();
    try {
      const ui = mountClient({ toasts: false });
      expect(probe.context()?.toast(REQUEST)).toBeNull();
      expect(storedToasts()).toEqual([]);
      ui.unregister();
    } finally {
      probe.restore();
    }
  });

  test("HostContext.toast with toasts enabled returns the toast id and stores it", () => {
    const probe = captureHostContext();
    try {
      const ui = mountClient();
      expect(probe.context()?.toast(REQUEST)).toEqual(expect.any(String));
      expect(storedToasts()).toHaveLength(1);
      ui.unregister();
    } finally {
      probe.restore();
    }
  });

  test("the first client's toasts setting governs a shared rejection listener", () => {
    const first = mountClient({ toasts: false });
    const second = mountClient();
    globalThis.dispatchEvent(rejection(new Error("TinyCloud storage failed")));
    expect(storedToasts()).toEqual([]);
    first.unregister();
    second.unregister();
  });

  test("when the toasts:false client unregisters, the remaining client's rejections toast again", () => {
    const first = mountClient({ toasts: false });
    const second = mountClient();
    first.unregister();
    globalThis.dispatchEvent(rejection(new Error("TinyCloud storage failed")));
    expect(storedToasts().length).toBe(1);
    second.unregister();
   });
});

describe("at-a-glance navigation", () => {
  const sectionId = () => shadow().querySelector("section[data-section]")?.getAttribute("data-section") ?? null;
  const glanceRow = (label: string) =>
    [...shadow().querySelectorAll<HTMLButtonElement>(".glance-row")].find((row) => row.textContent?.includes(label));

  test("a glance row opens its section in the open panel", async () => {
    const ui = mountClient(undefined, true);
    ui.api.open();
    await panelMounted();
    expect(sectionId()).toBe("account");
    const row = glanceRow(text("nav.storage"));
    expect(row).toBeDefined();
    row?.click();
    expect(sectionId()).toBe("storage");
    expect(ui.api.isOpen).toBe(true);
  });
});

describe("the app name the panel shows", () => {
  const headerContext = () => shadow().querySelector(".ctx")?.textContent;
  const pageCloseLabel = () => shadow().querySelector(".head button.action:not(.layout-switch)")?.textContent;

  function mountNamed(name: string | undefined, appId = "com.example.notes"): UiClientHandle {
    return registerUiClient({
      ui: undefined,
      source: source(false),
      manifestAppId: () => appId,
      manifestName: () => name,
    });
  }

  test("the manifest display name is shown, not the app id", async () => {
    const ui = mountNamed("Notes");
    ui.api.open();
    await panelMounted();
    expect(headerContext()).toBe(`${text("panel.in")} Notes`);
  });

  test("the page layout's way back names the display name too", async () => {
    const ui = mountNamed("Notes");
    ui.api.openPage();
    await panelMounted();
    expect(pageCloseLabel()).toBe(`${text("panel.back")} Notes`);
  });

  test("a missing or blank display name falls back to the app id", async () => {
    for (const name of [undefined, "", "   "]) {
      page.document.body.innerHTML = "";
      delete g[REGISTRY_KEY];
      const ui = mountNamed(name);
      ui.api.open();
      await panelMounted();
      expect(headerContext()).toBe(`${text("panel.in")} com.example.notes`);
    }
  });
});

describe("setButtonVisible", () => {
  test("true shows a button that ui.button:false left out and clears the stored hidden flag", () => {
    page.localStorage.setItem(hideKey(), "1");
    const ui = mountClient({ button: false });
    expect(buttonEl()).toBeNull();
    ui.api.setButtonVisible(true);
    expect(buttonEl()).not.toBeNull();
    expect(buttonEl()?.hidden).toBe(false);
    expect(hostState()).toBe("closed");
    expect(page.localStorage.getItem(hideKey())).toBeNull();
    buttonEl()?.click();
    expect(ui.api.isOpen).toBe(true);
  });

  test("true shows a button the user hid from the panel", () => {
    page.localStorage.setItem(hideKey(), "1");
    const ui = mountClient();
    expect(buttonEl()?.hidden).toBe(true);
    ui.api.setButtonVisible(true);
    expect(buttonEl()?.hidden).toBe(false);
    expect(page.localStorage.getItem(hideKey())).toBeNull();
  });

  test("false hides the button and leaves localStorage untouched", () => {
    const ui = mountClient();
    const before = page.localStorage.length;
    ui.api.setButtonVisible(false);
    expect(buttonEl()?.hidden).toBe(true);
    expect(hostState()).toBe("hidden");
    expect(page.localStorage.getItem(hideKey())).toBeNull();
    expect(page.localStorage.length).toBe(before);
  });

  test("false keeps an existing stored hidden flag as it is", () => {
    page.localStorage.setItem(hideKey(), "1");
    const ui = mountClient();
    ui.api.setButtonVisible(false);
    expect(page.localStorage.getItem(hideKey())).toBe("1");
  });

  test("open() and openPage() work while the button is hidden or left out, and do not bring a hidden button back", () => {
    const left = mountClient({ button: false });
    left.api.open();
    expect(left.api.isOpen).toBe(true);
    left.api.close();
    left.api.openPage();
    expect(left.api.isOpen).toBe(true);
    expect(buttonEl()).toBeNull();
    left.unregister();

    const hidden = mountClient();
    hidden.api.setButtonVisible(false);
    hidden.api.open();
    expect(hidden.api.isOpen).toBe(true);
    expect(buttonEl()?.hidden).toBe(true);
  });

  test("a later call wins", () => {
    const ui = mountClient({ button: false });
    ui.api.setButtonVisible(true);
    ui.api.setButtonVisible(false);
    expect(buttonEl()?.hidden).toBe(true);
    ui.api.setButtonVisible(true);
    expect(buttonEl()?.hidden).toBe(false);
  });
});

describe("setButtonVisible with a shared page", () => {
  test("a runtime from an older bundle registered first: the call is a no-op with one warning, the rest keeps working", () => {
    const older = createHostRuntime();
    delete older.setButtonVisible;
    g[REGISTRY_KEY] = { apiVersion: HOST_API_VERSION, runtime: older };
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const ui = mountClient();
      expect(() => ui.api.setButtonVisible(true)).not.toThrow();
      expect(() => ui.api.setButtonVisible(false)).not.toThrow();
      ui.api.open();
      expect(ui.api.isOpen).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([["[tinycloud] ui-host-set-button-visible-unsupported"]]);
  });

  test("ui.button:false then setButtonVisible(true): the panel's Overview offers Hide button, also while it is already open", async () => {
    const ui = mountClient({ button: false });
    ui.api.open();
    await panelMounted();
    expect(actionEl(text("panel.hide"))).toBeUndefined();
    ui.api.setButtonVisible(true);
    expect(actionEl(text("panel.hide"))).toBeDefined();
    ui.api.setButtonVisible(false);
    expect(actionEl(text("panel.hide"))).toBeUndefined();
    ui.api.setButtonVisible(true);
    ui.api.close();
    ui.api.open();
    expect(actionEl(text("panel.hide"))).toBeDefined();
  });
});
