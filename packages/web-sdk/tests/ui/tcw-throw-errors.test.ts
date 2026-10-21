import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import { REGISTRY_KEY } from "../../src/ui/host";
import { toastStore } from "../../src/ui/parts/toasts";
import type { ToastView } from "../../src/ui/toast-store";

type Config = NonNullable<ConstructorParameters<typeof TinyCloudWebType>[0]>;
type Loose = Record<PropertyKey, unknown>;
type Handler = {
  error(category: string, message: string, description?: string): void;
  success(message: string): void;
  warning(message: string, description?: string): void;
};

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
const GLOBAL_NAMES = [
  "window",
  "document",
  "location",
  "localStorage",
  "customElements",
  "HTMLElement",
  "Element",
  "Event",
  "KeyboardEvent",
];
const WINDOW_DEBOUNCE_MS = 200;

let page: Window;
let TinyCloudWeb: typeof TinyCloudWebType;
const saved = new Map<string, unknown>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realWarn = console.warn;
const realError = console.error;

// A tiny fake clock: timers run only when advance() moves time forward.
interface Timer {
  readonly callback: () => void;
  readonly at: number;
}
let now = 0;
let nextTimerId = 1;
const timers = new Map<number, Timer>();

function advance(ms: number): void {
  const target = now + ms;
  for (;;) {
    let due: [number, Timer] | undefined;
    for (const entry of timers) {
      if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
    }
    if (due === undefined) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].callback();
  }
  now = target;
}

beforeAll(async () => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: `${ORIGIN}/page` }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.location = page.location;
  g.localStorage = page.localStorage;
  g.customElements = page.customElements;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.KeyboardEvent = page.KeyboardEvent;
  // Same dynamic import and query suffix as tcw-app-id.test.ts.
  TinyCloudWeb = (await import("../../src/modules/tcw.ts?real-tcw")).TinyCloudWeb;
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
  timers.clear();
  now = 0;
  nextTimerId = 1;
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, { callback, at: now + delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof clearTimeout;
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  console.warn = realWarn;
  console.error = realError;
});

function create(config: Config): { tc: Loose; handler: Handler } {
  const tc = new TinyCloudWeb({ persistSession: false, ...config }) as unknown as Loose;
  return { tc, handler: tc.notificationHandler as Handler };
}

describe("TinyCloudWeb notifications.throwErrors", () => {
  test("an error event throws its raw message once the 200 ms window closes", () => {
    const { handler } = create({ notifications: { throwErrors: true } });
    handler.error("storage.upload_failed", "raw upstream reason", "details");
    expect(() => advance(WINDOW_DEBOUNCE_MS - 1)).not.toThrow();
    expect(() => advance(1)).toThrow("raw upstream reason");
  });

  test("identical error events inside the window collapse into one throw", () => {
    const { handler } = create({ notifications: { throwErrors: true } });
    handler.error("network.timeout", "raw timeout");
    advance(50);
    handler.error("network.timeout", "raw timeout");
    advance(50);
    handler.error("network.timeout", "raw timeout");
    expect(() => advance(WINDOW_DEBOUNCE_MS - 1)).not.toThrow();
    expect(() => advance(1)).toThrow("raw timeout");
    expect(() => advance(10 * WINDOW_DEBOUNCE_MS)).not.toThrow();
  });

  test("a repeat restarts the window, as the old emitter debounce did", () => {
    const { handler } = create({ notifications: { throwErrors: true } });
    handler.error("network.timeout", "raw timeout");
    advance(150);
    handler.error("network.timeout", "raw timeout");
    expect(() => advance(WINDOW_DEBOUNCE_MS - 1)).not.toThrow();
    expect(() => advance(1)).toThrow("raw timeout");
  });

  test("different error messages in the same window each throw", () => {
    const { handler } = create({ notifications: { throwErrors: true } });
    handler.error("network.timeout", "first reason");
    handler.error("network.timeout", "second reason");
    expect(() => advance(WINDOW_DEBOUNCE_MS)).toThrow("first reason");
    expect(() => advance(0)).toThrow("second reason");
  });

  test("success and warning notifications never throw", () => {
    const { handler } = create({ notifications: { throwErrors: true } });
    handler.success("Successfully signed in");
    handler.warning("careful");
    expect(() => advance(10 * WINDOW_DEBOUNCE_MS)).not.toThrow();
  });

  test("without throwErrors an error event throws nothing", () => {
    const { handler } = create({});
    handler.error("network.timeout", "raw timeout");
    expect(() => advance(10 * WINDOW_DEBOUNCE_MS)).not.toThrow();
  });

  test("headless ui (ui: false) throws nothing, matching the old popups: false", () => {
    const { handler } = create({ ui: false, notifications: { throwErrors: true } });
    handler.error("network.timeout", "raw timeout");
    expect(() => advance(10 * WINDOW_DEBOUNCE_MS)).not.toThrow();
  });

  test("ui.toasts:false throws nothing, matching the old popups: false", () => {
    const { handler } = create({ ui: { toasts: false }, notifications: { throwErrors: true } });
    handler.error("network.timeout", "raw timeout");
    expect(() => advance(10 * WINDOW_DEBOUNCE_MS)).not.toThrow();
  });

  test("ui.button:false with ui.toasts:false throws nothing", () => {
    const { handler } = create({
      ui: { button: false, toasts: false },
      notifications: { throwErrors: true },
    });
    handler.error("network.timeout", "raw timeout");
    expect(() => advance(10 * WINDOW_DEBOUNCE_MS)).not.toThrow();
  });

  test("legacy popups: false throws nothing", () => {
    const { handler } = create({ notifications: { popups: false, throwErrors: true } });
    handler.error("network.timeout", "raw timeout");
    expect(() => advance(10 * WINDOW_DEBOUNCE_MS)).not.toThrow();
  });

  test("ui.button:false alone keeps throws on", () => {
    const { handler } = create({ ui: { button: false }, notifications: { throwErrors: true } });
    handler.error("network.timeout", "raw timeout");
    expect(() => advance(WINDOW_DEBOUNCE_MS)).toThrow("raw timeout");
  });

  test("a framed page drops the toast but still throws, matching the old code", () => {
    // Old code had no frame guard: popups alone gated the listener and the throw.
    const real = g.window;
    g.window = Object.create(page, { top: { value: {} } });
    try {
      const { tc, handler } = create({ notifications: { throwErrors: true } });
      const showToast = tc.showToast as (r: { kind: string; textCode: string }) => boolean;
      expect(showToast({ kind: "error", textCode: "toast.error_generic" })).toBe(false);
      handler.error("network.timeout", "raw timeout");
      expect(() => advance(WINDOW_DEBOUNCE_MS)).toThrow("raw timeout");
    } finally {
      g.window = real;
    }
  });

  test("cleanup cancels a throw still waiting in its window", () => {
    const { tc, handler } = create({ notifications: { throwErrors: true } });
    handler.error("network.timeout", "raw timeout");
    const cleanup = tc.cleanup;
    if (typeof cleanup !== "function") throw new Error("TinyCloudWeb has no cleanup()");
    cleanup.call(tc);
    expect(() => advance(10 * WINDOW_DEBOUNCE_MS)).not.toThrow();
  });
});

describe("TinyCloudWeb.signOut clears only its own toasts", () => {
  function storedToasts(): readonly ToastView[] {
    let current: readonly ToastView[] = [];
    toastStore.subscribe((toasts) => {
      current = toasts;
    })();
    return current;
  }

  async function signOut(tc: Loose): Promise<void> {
    const fn = tc.signOut;
    if (typeof fn !== "function") throw new Error("TinyCloudWeb has no signOut()");
    await fn.call(tc);
  }

  beforeEach(() => {
    for (const toast of storedToasts()) toastStore.dismiss(toast.id);
  });

  test("signing out one client clears its toasts and leaves another client's", async () => {
    const a = create({});
    const b = create({});
    a.handler.success("Signed in");
    b.handler.error("network.timeout", "raw timeout");
    expect(storedToasts().map((toast) => toast.kind)).toEqual(["success", "error"]);
    await signOut(a.tc);
    expect(storedToasts().map((toast) => toast.kind)).toEqual(["error"]);
  });
});
