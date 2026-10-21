import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { registerUiClient, type UiClientHandle } from "../../src/ui";
import type { ClientSource } from "../../src/ui/client";
import { REGISTRY_KEY } from "../../src/ui/host";
import { toastStore } from "../../src/ui/parts/toasts";
import type { SyncFacade, SyncState } from "../../src/ui/slots";
import type { ToastKind, ToastView } from "../../src/ui/toast-store";

// Checks the shipped DOM against the stylesheet text the same shadow root carries.
// jsdom does not apply pointer-events or cascade styles, so the checks read the
// declarations and selectors directly. A class that a rule targets must exist on
// a rendered element, and every control must sit under a pointer-events:auto ancestor.

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
const GLOBAL_NAMES = ["window", "document", "location", "localStorage", "HTMLElement", "Element", "Event", "KeyboardEvent"];
const KINDS: readonly ToastKind[] = ["info", "success", "warning", "error"];

let page: Window;
const saved = new Map<string, unknown>();
const attached: ShadowRoot[] = [];
const handles: UiClientHandle[] = [];
let restoreAttachShadow: () => void = () => undefined;

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: `${ORIGIN}/page` }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.location = page.location;
  g.localStorage = page.localStorage;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.KeyboardEvent = page.KeyboardEvent;

  // The host's shadow root is closed. Record each root the host attaches so the
  // test can read the stylesheet and the rendered nodes.
  const proto = page.Element.prototype as unknown as { attachShadow(init: ShadowRootInit): ShadowRoot };
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
  for (const toast of storedToasts()) toastStore.dismiss(toast.id);
  for (const handle of handles.splice(0)) handle.unregister();
});

function storedToasts(): readonly ToastView[] {
  let current: readonly ToastView[] = [];
  toastStore.subscribe((toasts) => {
    current = toasts;
  })();
  return current;
}

function shadow(): ShadowRoot {
  const root = attached.at(-1);
  if (!root) throw new Error("no shadow root was created");
  return root;
}

function facade(state: SyncState): SyncFacade {
  return {
    state,
    subscribe: () => () => undefined,
    setEnabled: async () => undefined,
    wipeLocalData: async () => undefined,
  };
}

/** Registers a client with a sync facade and opens the panel. */
function openPanel(): void {
  const src = {
    signedIn: () => false,
    storage: { status: () => undefined },
    sync: facade({ requested: true, effective: "on" }),
  } as unknown as ClientSource;
  const handle = registerUiClient({ source: src, manifestAppId: () => undefined });
  handles.push(handle);
  handle.api.open();
}

/**
 * The store keeps at most three toasts, so one toast of each kind is shown in
 * turn. Returns every class applied to a rendered element across all four kinds.
 */
function appliedClassesAcrossKinds(): Set<string> {
  const applied = new Set<string>();
  for (const kind of KINDS) {
    const id = toastStore.push({
      kind,
      textCode: "panel.title",
      href: "https://example.com/docs",
      hrefLabelCode: "panel.close",
    });
    for (const el of shadow().querySelectorAll("[class]")) for (const cls of el.classList) applied.add(cls);
    toastStore.dismiss(id);
  }
  return applied;
}

/** Every class selector in the stylesheet text. */
function targetedClasses(css: string): Set<string> {
  return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

/** Classes named by any rule whose body declares pointer-events:auto. */
function pointerEventsAutoClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|;)\s*pointer-events\s*:\s*auto\s*(?:;|$)/.test(body)) continue;
    for (const [, cls] of selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(cls);
  }
  return out;
}

/** Stylesheet text with comments removed, so prose such as "tokens.css" is not read as a selector. */
function stylesheetText(root: ShadowRoot): string {
  const raw = [...root.querySelectorAll("style")].map((el) => el.textContent ?? "").join("\n");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("panel stylesheet targets", () => {
  test("every class a rule targets is applied to a rendered element", () => {
    openPanel();
    const applied = new Set([...shadow().querySelectorAll("[class]")].flatMap((el) => [...el.classList]));
    for (const cls of appliedClassesAcrossKinds()) applied.add(cls);
    const missing = [...targetedClasses(stylesheetText(shadow()))].filter((cls) => !applied.has(cls)).sort();
    expect(missing).toEqual([]);
  });

  test("the dialog element carries the panel class its pointer-events rule targets", () => {
    openPanel();
    const dialog = shadow().querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog?.classList.contains("panel")).toBe(true);
  });

  test("every control sits under a pointer-events:auto element", () => {
    openPanel();
    toastStore.push({ kind: "info", textCode: "panel.title", href: "https://example.com/docs", hrefLabelCode: "panel.close" });
    const root = shadow();
    const auto = pointerEventsAutoClasses(stylesheetText(root));
    const controls = [...root.querySelectorAll("button, a[href], [role='switch'], input, select, textarea")];
    expect(controls.length).toBeGreaterThan(0);
    const unreachable = controls
      .filter((el) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          if ([...node.classList].some((cls) => auto.has(cls))) return false;
        }
        return true;
      })
      .map((el) => el.outerHTML.slice(0, 80));
    expect(unreachable).toEqual([]);
  });
});

const DARK_HEADER = "@media (prefers-color-scheme: dark){";

/** Splits the stylesheet into its light rules and the body of the dark media block. */
function splitScheme(css: string): { light: string; dark: string } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = text.indexOf(DARK_HEADER);
  if (start < 0) return { light: text, dark: "" };
  const bodyStart = start + DARK_HEADER.length;
  let depth = 1;
  for (let i = bodyStart; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      return { light: text.slice(0, start) + text.slice(i + 1), dark: text.slice(bodyStart, i) };
    }
  }
  throw new Error("unbalanced dark media block");
}

/**
 * Declarations a single-class selector ends up with under a scheme. Dark rules
 * come after light ones, so a later declaration of the same property wins.
 */
function resolvedDeclarations(css: string, scheme: "light" | "dark", cls: string): Map<string, string> {
  const { light, dark } = splitScheme(css);
  const rules = scheme === "dark" ? `${light}\n${dark}` : light;
  const out = new Map<string, string>();
  for (const [, selector, body] of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.split(",").map((s) => s.trim()).includes(`.${cls}`)) continue;
    for (const decl of body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
    }
  }
  return out;
}

describe("panel colour scheme", () => {
  test("dark scheme paints the panel, toasts and text on the dark surface", () => {
    openPanel();
    toastStore.push({ kind: "warning", textCode: "panel.title", href: "https://example.com/docs", hrefLabelCode: "panel.close" });
    const css = stylesheetText(shadow());
    expect(resolvedDeclarations(css, "dark", "panel").get("background")).toBe("#151517");
    expect(resolvedDeclarations(css, "dark", "layer").get("color")).toBe("#fafafa");
    expect(resolvedDeclarations(css, "dark", "toast").get("background")).toBe("#151517");
    expect(resolvedDeclarations(css, "dark", "toast").get("color")).toBe("#fafafa");
    expect(resolvedDeclarations(css, "dark", "toast--warning").get("border-left-color")).toBe("#fbbd23");
  });

  test("light scheme keeps the light palette when no dark rule applies", () => {
    openPanel();
    const css = stylesheetText(shadow());
    expect(resolvedDeclarations(css, "light", "panel").get("background")).toBe("#fff");
    expect(resolvedDeclarations(css, "light", "layer").get("color")).toBe("#111827");
  });
});
