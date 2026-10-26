import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { createPanel, type PanelHandle } from "../../src/ui/panel";
import { PANEL_CSS } from "../../src/ui/panel-styles";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "getComputedStyle"];

let page: Window;
const saved = new Map<string, unknown>();

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  for (const name of GLOBAL_NAMES.slice(2)) g[name] = (page as unknown as Loose)[name];
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

afterEach(() => {
  page.document.body.innerHTML = "";
  page.document.head.innerHTML = "";
});

interface Fixture {
  readonly panel: PanelHandle;
  readonly head: HTMLElement;
  readonly calls: { close: number; escape: number };
}

function fixture(): Fixture {
  const calls = { close: 0, escape: 0 };
  const panel = createPanel({
    onClose: () => void (calls.close += 1),
    onEscape: () => void (calls.escape += 1),
    onLayout() {},
    onNavigate() {},
  });
  panel.setLayout("page", { showLayoutToggle: false, phone: true });
  panel.setOpen(true);
  page.document.body.append(panel.el);
  return { panel, head: panel.el.querySelector<HTMLElement>(".head") as HTMLElement, calls };
}

/** jsdom has no PointerEvent; the panel reads only these fields. */
function pointer(target: Element, type: string, init: { id?: number; x: number; y: number; kind?: string }): void {
  const event = new (page as unknown as { Event: typeof Event }).Event(type, { bubbles: true });
  Object.assign(event, { pointerId: init.id ?? 1, pointerType: init.kind ?? "touch", clientX: init.x, clientY: init.y });
  target.dispatchEvent(event);
}

function drag(target: Element, dx: number, dy: number, kind = "touch"): void {
  pointer(target, "pointerdown", { x: 100, y: 20, kind });
  pointer(target, "pointerup", { x: 100 + dx, y: 20 + dy, kind });
}

describe("closing the full-page panel on a phone", () => {
  test("Escape closes it", () => {
    const f = fixture();
    f.panel.el.dispatchEvent(new (page as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(f.calls.escape).toBe(1);
  });

  test("a downward drag of 60px on the header closes it", () => {
    const f = fixture();
    drag(f.head.querySelector(".brand") as Element, 0, 60);
    expect(f.calls.close).toBe(1);
  });

  test("a drag shorter than 60px, an upward drag and a mostly sideways drag leave it open", () => {
    const f = fixture();
    const brand = f.head.querySelector(".brand") as Element;
    drag(brand, 0, 59);
    drag(brand, 0, -120);
    drag(brand, 150, 70);
    expect(f.calls.close).toBe(0);
  });

  test("a mouse drag, a cancelled touch and a drag that starts on a control do not close it", () => {
    const f = fixture();
    const brand = f.head.querySelector(".brand") as Element;
    drag(brand, 0, 120, "mouse");
    pointer(brand, "pointerdown", { x: 100, y: 20 });
    pointer(brand, "pointercancel", { x: 100, y: 20 });
    pointer(brand, "pointerup", { x: 100, y: 200 });
    drag(f.head.querySelector("button") as Element, 0, 120);
    expect(f.calls.close).toBe(0);
  });
});

describe("the header and the safe area", () => {
  test("the header is sticky at the top and the panel pads for every inset", () => {
    const f = fixture();
    const style = page.document.createElement("style");
    style.textContent = PANEL_CSS;
    page.document.head.append(style);
    const head = page.getComputedStyle(f.head);
    expect(head.position).toBe("sticky");
    expect(head.top).toBe("0px");
    // jsdom discards env() values, so the inset padding is read from the rule text.
    const rule = PANEL_CSS.match(/\n\.panel\{[^}]*\}/)?.[0] ?? "";
    for (const side of ["top", "right", "bottom", "left"]) expect(rule).toContain(`env(safe-area-inset-${side},0px)`);
  });

  test("the close control is at least 44px square", () => {
    const f = fixture();
    const style = page.document.createElement("style");
    style.textContent = PANEL_CSS;
    page.document.head.append(style);
    const close = f.head.querySelector(".head-actions > button:last-child") as HTMLElement;
    expect(close.className).toContain("icon-btn");
    const rule = PANEL_CSS.match(/\.icon-btn\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("width:44px");
    expect(rule).toContain("height:44px");
  });
});
