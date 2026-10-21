import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { registerUiClient, type UiClientHandle } from "../../src/ui";
import type { ClientSource } from "../../src/ui/client";
import { REGISTRY_KEY } from "../../src/ui/host";
import { HIDE_KEY_PREFIX } from "../../src/ui/persistence";
import { text } from "../../src/ui/strings";
import type { SyncFacade, SyncState } from "../../src/ui/slots";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
const GLOBAL_NAMES = ["window", "document", "location", "localStorage", "HTMLElement", "Element", "Event", "KeyboardEvent"];

let page: Window;
const saved = new Map<string, unknown>();
const attached: ShadowRoot[] = [];
let restoreAttachShadow: () => void = () => undefined;

// jsdom makes window.top and window.location unforgeable. Framed and
// opaque-origin tests override them through this view of the global window.
const overrides = new Map<PropertyKey, unknown>();
let view: Window;

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

  // Record every shadow root the host creates. The root is closed, so the
  // tests reach into it through this recording only.
  const proto = page.Element.prototype as unknown as {
    attachShadow(init: ShadowRootInit): ShadowRoot;
  };
  const original = proto.attachShadow;
  proto.attachShadow = function attachShadow(this: unknown, init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, init);
    attached.push(root);
    return root;
  };
  restoreAttachShadow = () => {
    proto.attachShadow = original;
  };
});

afterAll(() => {
  restoreAttachShadow();
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

beforeEach(() => {
  delete g[REGISTRY_KEY];
  attached.length = 0;
  page.document.body.innerHTML = "";
  page.localStorage.clear();
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
  const root = attached.at(-1);
  if (!root) throw new Error("no shadow root was created");
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
  test("mounts one closed host at z-index 999990", () => {
    mountClient();
    expect(hostEl()).not.toBeNull();
    expect(hostEl()?.shadowRoot).toBeNull();
    expect(hostEl()?.style.zIndex).toBe("999990");
    expect(hostState()).toBe("closed");
    expect(attached.length).toBe(1);
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

  test("the panel hide control sets the flag and closes", () => {
    const ui = mountClient();
    ui.api.open();
    actionEl(text("panel.hide"))?.click();
    expect(page.localStorage.getItem(hideKey())).toBe("1");
    expect(hostState()).toBe("hidden");
    expect(ui.api.isOpen).toBe(false);
  });

  test("close never changes the hidden flag", () => {
    const ui = mountClient();
    ui.api.open();
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

  test("Escape on the panel element closes it", () => {
    const ui = mountClient();
    ui.api.open();
    const panel = shadow().querySelector("[role='dialog']") as HTMLElement;
    panel.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(ui.api.isOpen).toBe(false);
  });
});

describe("headless modes", () => {
  test("ui:false creates no host and every method is a silent no-op", () => {
    const ui = mountClient(false);
    expect(hostEl()).toBeNull();
    expect(attached.length).toBe(0);
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

  test("unregistering the last client hides the dot", () => {
    const sync = syncStub({ requested: false, effective: "pending" });
    const ui = mountWithSync(sync.facade);
    ui.unregister();
    expect(dotEl()?.hidden).toBe(true);
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
