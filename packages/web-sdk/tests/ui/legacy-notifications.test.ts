import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import { REGISTRY_KEY } from "../../src/ui/host";
import { toastStore } from "../../src/ui/parts/toasts";
import { mountPrompt, type PromptScope } from "../../src/ui/parts/prompts";

type ModalsModule = typeof import("../../src/notifications/ModalManager");
let showPermissionRequestModal: ModalsModule["showPermissionRequestModal"];
let showSpaceCreationModal: ModalsModule["showSpaceCreationModal"];

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
  "requestAnimationFrame",
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
  // JSDOM has no requestAnimationFrame; the modal's connectedCallback calls it.
  g.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

  TinyCloudWeb = (await import("../../src/modules/tcw.ts?legacy-notifications")).TinyCloudWeb;
  // Loaded after the globals exist: the modal modules extend HTMLElement at import time.
  ({ showPermissionRequestModal, showSpaceCreationModal } = await import("../../src/notifications/ModalManager"));
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

// The toast store is a module singleton; a toast left by one test would render into the next host.
function clearToasts(): void {
  let current: readonly { id: string }[] = [];
  toastStore.subscribe((toasts) => {
    current = toasts;
  })();
  for (const toast of current) toastStore.dismiss(toast.id);
}

beforeEach(() => {
  delete g[REGISTRY_KEY];
  page.document.body.innerHTML = "";
  page.localStorage.clear();
  clearToasts();
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

// The scope the instance hands to its modal call sites, as tcw.ts does.
function promptScopeOf(tc: Loose): PromptScope {
  return (tc.uiClient as { promptScope: PromptScope }).promptScope;
}

// Constructor tests share one module instance, so they assert behaviour only, never warnings.
describe("legacy notifications.popups", () => {
  test("popups: false keeps the host and no button, and the UI stays available for prompts", () => {
    const legacy = create({ notifications: { popups: false } });
    expect(hostEl()).not.toBeNull();
    expect(shadow().querySelector("button[aria-controls]")).toBeNull();
    expect((legacy.ui as { available: boolean }).available).toBe(true);
  });

  test("popups: false shows no toast for an error event and reports the toast as not shown", () => {
    const legacy = create({ notifications: { popups: false } });
    expect(showError(legacy)).toBe(false);
    const handler = legacy.notificationHandler as { error?: (c: string, m: string) => void } | undefined;
    if (typeof handler?.error !== "function") throw new Error("no notification handler on the instance");
    const realError = console.error;
    console.error = () => {};
    try {
      handler.error("network.timeout", "raw timeout");
    } finally {
      console.error = realError;
    }
    expect(shadow().querySelector(".toast")).toBeNull();
  });

  test("without popups the same error event does show a toast", () => {
    const tc = create({});
    (tc.notificationHandler as { error(c: string, m: string): void }).error("network.timeout", "raw timeout");
    expect(shadow().querySelector(".toast")).not.toBeNull();
  });

  test("ui: false still renders nothing", () => {
    create({ ui: false });
    expect(hostEl()).toBeNull();
  });

  test("an explicit ui wins over popups: false", () => {
    const tc = create({ notifications: { popups: false }, ui: { button: true } });
    expect(shadow().querySelector("button[aria-controls]")).not.toBeNull();
    expect(showError(tc)).toBe(true);
  });
});

// Every modal goes through mountPrompt, so this checks the gate the modals hit.
// Modals are not used here: bun shares one module cache across test files, and
// prompts.test.ts loads ModalManager against its fake HTMLElement, which real
// jsdom nodes reject. The real modal path runs in the e2e specs.
function expectPromptMounts(tc: Loose): void {
  const layer = shadow().querySelector(".layer") as Element;
  const before = layer.childElementCount;
  const mount = mountPrompt(promptScopeOf(tc), document.createElement("div"), () => {});
  expect("refusal" in mount).toBe(false);
  expect(layer.childElementCount).toBe(before + 1);
  expect(warnings.filter((w) => w.includes("ui-"))).toEqual([]);
  if (!("refusal" in mount)) mount.release();
}

describe("legacy notifications.popups keeps SDK prompts", () => {
  test("popups: false mounts SDK prompts in the host layer with no refusal warning", () => {
    expectPromptMounts(create({ notifications: { popups: false } }));
  });

  test("ui: false refuses a space creation prompt: resolves dismissed, mounts nothing, warns once", async () => {
    const tc = create({ ui: false });
    const result = await showSpaceCreationModal(
      { onCreateSpace: async () => {}, onDismiss: () => {} },
      promptScopeOf(tc),
    );
    expect(result).toEqual({ success: false, dismissed: true });
    expect(hostEl()).toBeNull();
    expect(warnings.filter((w) => w.includes("ui-"))).toEqual(["[tinycloud] ui-disabled"]);
  });

  test("ui: false refuses a permission prompt: resolves declined, mounts nothing, warns once", async () => {
    const tc = create({ ui: false });
    const result = await showPermissionRequestModal(
      { appName: "Test App", additional: [], onDismiss: () => {} },
      promptScopeOf(tc),
    );
    expect(result).toEqual({ approved: false });
    expect(hostEl()).toBeNull();
    expect(warnings.filter((w) => w.includes("ui-"))).toEqual(["[tinycloud] ui-disabled"]);
  });

  test("ui button and toasts off still mounts SDK prompts in the host layer", () => {
    expectPromptMounts(create({ ui: { button: false, toasts: false } }));
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
  test("popups: false maps to button and toasts off, and never mutates the caller's object", async () => {
    const apply = await freshMapper();
    const input = { notifications: { popups: false } };
    const out = apply(input);
    expect(out.ui).toEqual({ button: false, toasts: false });
    expect(input).toEqual({ notifications: { popups: false } });
  });

  test("popups: false keeps a legacy position on the mapped object", async () => {
    const apply = await freshMapper();
    expect(apply({ notifications: { popups: false, position: "top-left" } }).ui).toEqual({
      button: false,
      toasts: false,
      position: "top-left",
    });
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
    expect(apply({ notifications: { popups: false } }).ui).toEqual({ button: false, toasts: false });
  });
});
