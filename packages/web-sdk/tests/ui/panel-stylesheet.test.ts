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
const handles: UiClientHandle[] = [];

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
  const root = document.querySelector<HTMLElement>("[data-tinycloud-ui]")?.shadowRoot;
  if (!root) throw new Error("no open shadow root on the TinyCloud host");
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

/**
 * Splits the stylesheet into its light rules and the bodies of every dark media
 * block. The panel and toast stylesheets are separate <style> elements, so there
 * is more than one block; each one must leave the light rules.
 */
function splitScheme(css: string): { light: string; dark: string } {
  let rest = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let light = "";
  let dark = "";
  for (;;) {
    const start = rest.indexOf(DARK_HEADER);
    if (start < 0) return { light: light + rest, dark };
    light += rest.slice(0, start);
    const bodyStart = start + DARK_HEADER.length;
    let depth = 1;
    let i = bodyStart;
    for (; i < rest.length && depth > 0; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}") depth--;
    }
    if (depth !== 0) throw new Error("unbalanced dark media block");
    dark += `\n${rest.slice(bodyStart, i - 1)}`;
    rest = rest.slice(i);
  }
}

/**
 * Declarations a selector ends up with under a scheme. Dark rules come after
 * light ones, so a later declaration of the same property wins.
 */
function resolvedDeclarations(css: string, scheme: "light" | "dark", selector: string): Map<string, string> {
  const { light, dark } = splitScheme(css);
  const rules = scheme === "dark" ? `${light}\n${dark}` : light;
  const out = new Map<string, string>();
  for (const [, listed, body] of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!listed.split(",").map((s) => s.trim()).includes(selector)) continue;
    for (const decl of body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
    }
  }
  return out;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * Colour longhands an element with `classes` ends up with under a scheme. Only
 * single-class selectors (`.name`) match. Rules apply in source order, so a later
 * rule wins at equal specificity. `border` and `border-color` expand to all four
 * sides, and a shorthand resets any side longhand set earlier, as the cascade does.
 */
function cascadedColours(css: string, scheme: "light" | "dark", classes: readonly string[]): Map<string, string> {
  const { light, dark } = splitScheme(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  const rules = scheme === "dark" ? `${light}\n${dark}` : light;
  const wanted = new Set(classes.map((c) => `.${c}`));
  const out = new Map<string, string>();
  for (const [, listed, body] of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!listed.split(",").some((s) => wanted.has(s.trim()))) continue;
    for (const decl of body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      const prop = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (prop === "border") {
        const colour = value.split(/\s+/).find((t) => t.startsWith("#") || t.startsWith("rgb")) ?? "currentcolor";
        for (const side of SIDES) out.set(`border-${side}-color`, colour);
      } else if (prop === "border-color") {
        if (/\s/.test(value)) throw new Error(`multi-value border-color is not modelled: ${value}`);
        for (const side of SIDES) out.set(`border-${side}-color`, value);
      } else if (/^border-(top|right|bottom|left)-color$/.test(prop)) {
        out.set(prop, value);
      }
    }
  }
  return out;
}

/** WCAG 2.x relative luminance of a #rgb or #rrggbb colour. Anything else throws. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_MIN = 4.5;
const GRAPHIC_MIN = 3;

/** A foreground and background, each a [selector, property] pair, and the minimum ratio. */
interface ContrastCheck {
  name: string;
  fg: [string, string];
  bg: [string, string];
  min: number;
}

const CONTRAST_CHECKS: readonly ContrastCheck[] = [
  { name: "panel text", fg: [".layer", "color"], bg: [".panel", "background"], min: TEXT_MIN },
  { name: "panel dim text", fg: [".status", "color"], bg: [".panel", "background"], min: TEXT_MIN },
  { name: "panel error text", fg: [".error", "color"], bg: [".panel", "background"], min: TEXT_MIN },
  { name: "action label", fg: [".action", "color"], bg: [".action", "background"], min: TEXT_MIN },
  { name: "toast text", fg: [".toast", "color"], bg: [".toast", "background"], min: TEXT_MIN },
  { name: "button glyph", fg: [".button", "color"], bg: [".button", "background"], min: GRAPHIC_MIN },
  { name: "button notice dot", fg: [".dot", "background"], bg: [".button", "background"], min: GRAPHIC_MIN },
  { name: "switch track off", fg: [".knob", "background"], bg: [".panel", "background"], min: GRAPHIC_MIN },
  { name: "switch thumb", fg: [".knob::after", "background"], bg: [".knob", "background"], min: GRAPHIC_MIN },
  { name: "switch track on", fg: [".switch[aria-checked=\"true\"] .knob", "background"], bg: [".panel", "background"], min: GRAPHIC_MIN },
];

/** Stylesheet text with a warning toast rendered, so every toast rule is present. */
function renderedCss(): string {
  openPanel();
  toastStore.push({ kind: "warning", textCode: "panel.title", href: "https://example.com/docs", hrefLabelCode: "panel.close" });
  return stylesheetText(shadow());
}

describe("panel colour scheme", () => {
  test("dark scheme paints the panel, toasts and text on the dark surface", () => {
    const css = renderedCss();
    expect(resolvedDeclarations(css, "dark", ".panel").get("background")).toBe("#151517");
    expect(resolvedDeclarations(css, "dark", ".layer").get("color")).toBe("#fafafa");
    expect(resolvedDeclarations(css, "dark", ".toast").get("background")).toBe("#151517");
    expect(resolvedDeclarations(css, "dark", ".toast").get("color")).toBe("#fafafa");
    expect(resolvedDeclarations(css, "dark", ".toast--warning").get("border-left-color")).toBe("#fbbd23");
  });

  test("light scheme keeps the light palette when no dark rule applies", () => {
    const css = renderedCss();
    expect(resolvedDeclarations(css, "light", ".panel").get("background")).toBe("#fff");
    expect(resolvedDeclarations(css, "light", ".layer").get("color")).toBe("#111827");
  });
});

for (const scheme of ["light", "dark"] as const) {
  describe(`panel contrast, ${scheme} scheme`, () => {
    for (const check of CONTRAST_CHECKS) {
      test(`${check.name} is at least ${check.min}:1`, () => {
        const css = renderedCss();
        const fg = resolvedDeclarations(css, scheme, check.fg[0]).get(check.fg[1]) ?? "";
        const bg = resolvedDeclarations(css, scheme, check.bg[0]).get(check.bg[1]) ?? "";
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(check.min);
      });
    }
  });
}

/** Interactive controls the panel renders. Each needs its own focus ring rule. */
const FOCUS_SELECTORS = [".button", ".action", ".switch", ".toast a", ".toast__close"] as const;
const RING_COLOUR: Record<"light" | "dark", string> = { light: "#111827", dark: "#fafafa" };
/**
 * Page surfaces a ring can sit on: a light host page and a dark one. A ring is
 * drawn outside its element, so the page behind it decides its contrast. Each
 * ring also gets a 6px halo of the opposite ink, so one of the two always clears 3:1.
 */
const BACKGROUNDS = ["#ffffff", "#0b0c10"] as const;

describe("focus ring coverage", () => {
  test("every rendered interactive element matches a focus-ring selector", () => {
    openPanel();
    toastStore.push({ kind: "warning", textCode: "panel.title", href: "https://example.com/docs", hrefLabelCode: "panel.close" });
    const found = [...shadow().querySelectorAll("button, a[href], [role='switch'], input, select, textarea")];
    expect(found.length).toBeGreaterThan(0);
    const unmatched = found.filter((el) => !FOCUS_SELECTORS.some((sel) => el.matches(sel))).map((el) => el.outerHTML);
    expect(unmatched).toEqual([]);
  });
});

for (const scheme of ["light", "dark"] as const) {
  describe(`focus ring, ${scheme} scheme`, () => {
    for (const sel of FOCUS_SELECTORS) {
      test(`${sel} draws a 2px solid ring at 2px offset`, () => {
        const decl = resolvedDeclarations(renderedCss(), scheme, `${sel}:focus-visible`);
        const shorthand = decl.get("outline") ?? "";
        // A later outline-color (the dark rule) overrides the colour of the shorthand.
        const colour = decl.get("outline-color") ?? shorthand.split(/\s+/).at(-1);
        expect(shorthand.startsWith("2px solid")).toBe(true);
        expect(colour).toBe(RING_COLOUR[scheme]);
        expect(decl.get("outline-offset")).toBe("2px");
      });
      test(`${sel} ring or halo is at least ${GRAPHIC_MIN}:1 on each page background`, () => {
        const decl = resolvedDeclarations(renderedCss(), scheme, `${sel}:focus-visible`);
        const ring = decl.get("outline-color") ?? decl.get("outline")?.split(/\s+/).at(-1) ?? "";
        const halo = /0 0 0 6px (#[0-9a-fA-F]{3,6})/.exec(decl.get("box-shadow") ?? "")?.[1];
        if (!halo) throw new Error(`${sel} has no 6px halo for ${scheme}`);
        for (const bg of BACKGROUNDS) {
          expect(Math.max(contrastRatio(ring, bg), contrastRatio(halo, bg))).toBeGreaterThanOrEqual(GRAPHIC_MIN);
        }
      });
    }
  });
}

describe("host shadow root", () => {
  test("the host root is open and reachable from document", () => {
    openPanel();
    const host = document.querySelector<HTMLElement>("[data-tinycloud-ui]");
    expect(host?.shadowRoot).not.toBeNull();
    expect(host?.shadowRoot?.querySelector("#tinycloud-ui-panel")).not.toBeNull();
  });
});

// Stripe colour per kind. The warning stripe is the only dark override.
const STRIPE: Record<ToastKind, { light: string; dark: string }> = {
  info: { light: "#2563eb", dark: "#2563eb" },
  success: { light: "#16a34a", dark: "#16a34a" },
  warning: { light: "#d97706", dark: "#fbbd23" },
  error: { light: "#dc2626", dark: "#dc2626" },
};

describe("toast stripe colour", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const kind of KINDS) {
      test(`${scheme} ${kind} stripe is its kind colour and at least 3:1 on the toast surface`, () => {
        const css = renderedCss();
        const stripe = cascadedColours(css, scheme, ["toast", `toast--${kind}`]).get("border-left-color");
        const surface = resolvedDeclarations(css, scheme, ".toast").get("background");
        if (!stripe || !surface) throw new Error(`no resolved stripe or surface for ${kind}`);
        expect(stripe).toBe(STRIPE[kind][scheme]);
        expect(contrastRatio(stripe, surface)).toBeGreaterThanOrEqual(GRAPHIC_MIN);
      });
    }
  }
});
