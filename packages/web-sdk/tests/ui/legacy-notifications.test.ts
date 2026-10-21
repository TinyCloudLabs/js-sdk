import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import { REGISTRY_KEY } from "../../src/ui/host";

type Config = NonNullable<ConstructorParameters<typeof TinyCloudWebType>[0]>;
type Loose = Record<PropertyKey, unknown>;
type Mapper = <T extends { ui?: unknown; notifications?: object }>(config: T) => T;

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

let page: Window;
let TinyCloudWeb: typeof TinyCloudWebType;
const saved = new Map<string, unknown>();
const realWarn = console.warn;
let warnings: string[] = [];
let freshCounter = 0;

// Each query suffix is a separate module instance, so its once-per-key warning set starts empty.
async function freshMapper(): Promise<Mapper> {
  const mod = await import(`../../src/notifications/legacy-config.ts?fresh=${freshCounter++}`);
  return mod.applyLegacyNotificationKeys as Mapper;
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

  TinyCloudWeb = (await import("../../src/modules/tcw.ts?legacy-notifications")).TinyCloudWeb;
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
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.warn = realWarn;
});

function hostEl(): HTMLElement | null {
  return page.document.querySelector("[data-tinycloud-ui]") as HTMLElement | null;
}

// Throws when no host or root exists, so a missing host can never pass as `undefined`.
function shadow(): ShadowRoot {
  const root = hostEl()?.shadowRoot;
  if (!root) throw new Error("no open shadow root on the TinyCloud host");
  return root;
}

function create(config: Record<string, unknown>): Loose {
  return new TinyCloudWeb({ persistSession: false, ...(config as Config) }) as unknown as Loose;
}

function showError(tc: Loose): boolean {
  return (tc.showToast as (r: { kind: string; textCode: string }) => boolean)({
    kind: "error",
    textCode: "toast.error_generic",
  });
}

function layerPosition(): string | null {
  const layer = shadow().querySelector(".layer");
  if (!layer) throw new Error("no .layer in the shadow root");
  return layer.getAttribute("data-position");
}

// Constructor tests share one module instance, so they assert behaviour only, never warnings.
describe("legacy notifications.popups", () => {
  test("popups: false behaves exactly like ui: false (no host, no toasts)", () => {
    const legacy = create({ notifications: { popups: false } });
    expect(hostEl()).toBeNull();
    expect(showError(legacy)).toBe(false);
    create({ ui: false });
    expect(hostEl()).toBeNull();
  });

  test("an explicit ui wins over popups: false", () => {
    const tc = create({ notifications: { popups: false }, ui: { button: true } });
    expect(shadow().querySelector("button[aria-controls]")).not.toBeNull();
    expect(showError(tc)).toBe(true);
  });
});

describe("legacy notifications.position", () => {
  test("position top-left places the layer at bottom-left, as ui.position would", () => {
    create({ notifications: { position: "top-left" } });
    expect(layerPosition()).toBe("bottom-left");
  });

  test("an explicit ui.position wins over the legacy position", () => {
    create({ notifications: { position: "top-left" }, ui: { position: "bottom-center" } });
    expect(layerPosition()).toBe("bottom-center");
  });

  for (const [label, position] of [
    ["a number", 42],
    ["an object", { side: "top" }],
    ["null", null],
  ] as const) {
    test(`a legacy position that is ${label} falls back to bottom-right without throwing`, () => {
      expect(() => create({ notifications: { position } })).not.toThrow();
      expect(layerPosition()).toBe("bottom-right");
    });
  }
});

describe("legacy notifications.duration and maxVisible", () => {
  test("neither changes behaviour: toasts still show", () => {
    const tc = create({ notifications: { duration: 1000, maxVisible: 1 } });
    expect(showError(tc)).toBe(true);
  });
});

describe("legacy key mapping (pure)", () => {
  test("popups: false maps to ui: false and never mutates the caller's object", async () => {
    const apply = await freshMapper();
    const input = { notifications: { popups: false } };
    const out = apply(input);
    expect(out.ui).toBe(false);
    expect(input).toEqual({ notifications: { popups: false } });
  });

  test("popups: true and absent keys leave the config's ui untouched", async () => {
    const apply = await freshMapper();
    expect(apply({ notifications: { popups: true } }).ui).toBeUndefined();
    expect(apply({ ui: { button: false } }).ui).toEqual({ button: false });
  });

  test("a legacy position never overrides an explicit ui.position or a ui: false", async () => {
    const apply = await freshMapper();
    expect(apply({ notifications: { position: "top-left" }, ui: false }).ui).toBe(false);
    expect(apply({ notifications: { position: "top-left" }, ui: { position: "bottom-left" } }).ui).toEqual({
      position: "bottom-left",
    });
  });

  test("the warning names the key and its replacement, never the value", async () => {
    const apply = await freshMapper();
    apply({ notifications: { popups: false, position: "top-left", duration: 1234, maxVisible: 99 } });
    expect(warnings).toHaveLength(4);
    for (const warning of warnings) {
      expect(warning).toContain("(code: legacy-notification-key)");
      expect(warning).not.toContain("1234");
      expect(warning).not.toContain("top-left");
      expect(warning).not.toContain("99");
    }
    expect(warnings.some((w) => w.includes("notifications.popups") && w.includes("use ui"))).toBe(true);
    expect(warnings.some((w) => w.includes("notifications.position") && w.includes("use ui.position"))).toBe(true);
    expect(warnings.some((w) => w.includes("notifications.duration"))).toBe(true);
    expect(warnings.some((w) => w.includes("notifications.maxVisible"))).toBe(true);
  });

  test("each key warns once per module instance, however many configs pass through", async () => {
    const apply = await freshMapper();
    apply({ notifications: { popups: false } });
    apply({ notifications: { popups: false } });
    apply({ notifications: { popups: true } });
    expect(warnings.filter((w) => w.includes("notifications.popups"))).toHaveLength(1);
  });

  test("a throwing console.warn never stops the mapping", async () => {
    const apply = await freshMapper();
    console.warn = () => {
      throw new Error("console unavailable");
    };
    expect(apply({ notifications: { popups: false } }).ui).toBe(false);
  });
});
