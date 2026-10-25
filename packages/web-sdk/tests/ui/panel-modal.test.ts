import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { createPanel } from "../../src/ui/panel";
import { mountDrawerModal, type DrawerModal } from "../../src/ui/panel-modal";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "FocusEvent"];

let page: Window;
const saved = new Map<string, unknown>();
const cleanups: Array<() => void> = [];

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
  for (const cleanup of cleanups.splice(0)) cleanup();
  page.document.body.innerHTML = "";
});

function button(label: string, parent: HTMLElement): HTMLButtonElement {
  const el = page.document.createElement("button");
  el.type = "button";
  el.textContent = label;
  parent.append(el);
  return el;
}

interface Fixture {
  readonly modal: DrawerModal;
  readonly root: ShadowRoot;
  readonly layer: HTMLElement;
  readonly panel: HTMLElement;
  readonly pageButton: HTMLButtonElement;
  readonly controls: readonly HTMLButtonElement[];
  readonly dismissed: { count: number };
  addToast(): HTMLButtonElement;
}

function fixture(): Fixture {
  const pageButton = button("page", page.document.body);
  const host = page.document.createElement("div");
  page.document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const layer = page.document.createElement("div");
  layer.className = "layer";
  const launcher = page.document.createElement("button");
  launcher.className = "button";
  const stand = page.document.createElement("div");
  stand.className = "pending";
  layer.append(launcher, stand);
  root.append(layer);

  const panel = page.document.createElement("div");
  panel.id = "tinycloud-ui-panel";
  const controls = [button("first", panel), button("second", panel), button("last", panel)];
  stand.replaceWith(panel);
  // The stand-in is gone by the time the panel module mounts in production only after the scrim is placed; mirror that order.
  const dismissed = { count: 0 };
  const placeholder = page.document.createElement("div");
  placeholder.className = "pending";
  layer.insertBefore(placeholder, panel);
  const modal = mountDrawerModal(root as ShadowRoot, layer, panel, () => {
    dismissed.count += 1;
  });
  placeholder.remove();
  cleanups.push(() => modal.dispose());
  return {
    modal,
    root,
    layer,
    panel,
    pageButton,
    controls,
    dismissed,
    addToast() {
      const stack = page.document.createElement("div");
      stack.className = "tstack";
      const close = button("dismiss toast", stack);
      layer.append(stack);
      return close;
    },
  };
}

function press(target: HTMLElement, key: string, shiftKey = false): KeyboardEvent {
  const event = new (page as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
    key,
    shiftKey,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("the scrim", () => {
  test("sits in the layer before the panel, and a click on it dismisses", () => {
    const f = fixture();
    const scrim = f.layer.querySelector<HTMLElement>(".scrim");
    expect(scrim).not.toBeNull();
    expect(scrim?.getAttribute("aria-hidden")).toBe("true");
    expect(scrim?.nextElementSibling?.id === "tinycloud-ui-panel" || scrim?.nextElementSibling?.className === "pending").toBe(true);
    scrim?.click();
    expect(f.dismissed.count).toBe(1);
  });

  test("dispose removes it", () => {
    const f = fixture();
    f.modal.dispose();
    expect(f.layer.querySelector(".scrim")).toBeNull();
  });
});

describe("Tab in the drawer", () => {
  test("from the last control goes to the first; Shift+Tab from the first goes to the last", () => {
    const f = fixture();
    f.modal.sync(true, true);
    const [first, , last] = f.controls as [HTMLElement, HTMLElement, HTMLElement];

    last.focus();
    const forward = press(last, "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(f.root.activeElement).toBe(first);

    const backward = press(first, "Tab", true);
    expect(backward.defaultPrevented).toBe(true);
    expect(f.root.activeElement).toBe(last);
  });

  test("in the middle the browser's own order is left alone", () => {
    const f = fixture();
    f.modal.sync(true, true);
    const second = f.controls[1] as HTMLElement;
    second.focus();
    expect(press(second, "Tab").defaultPrevented).toBe(false);
    expect(press(second, "Tab", true).defaultPrevented).toBe(false);
  });

  test("a toast's control is the last stop, after the panel's", () => {
    const f = fixture();
    const toast = f.addToast();
    f.modal.sync(true, true);
    const last = f.controls[2] as HTMLElement;
    expect(press(last, "Tab").defaultPrevented).toBe(false);
    toast.focus();
    expect(press(toast, "Tab").defaultPrevented).toBe(true);
    expect(f.root.activeElement).toBe(f.controls[0]);
    expect(press(f.controls[0] as HTMLElement, "Tab", true).defaultPrevented).toBe(true);
    expect(f.root.activeElement).toBe(toast);
  });

  test("Escape from a toast dismisses the drawer; from the panel it is the panel's own to handle", () => {
    const f = fixture();
    const toast = f.addToast();
    f.modal.sync(true, true);
    toast.focus();
    press(toast, "Escape");
    expect(f.dismissed.count).toBe(1);
    (f.controls[0] as HTMLElement).focus();
    press(f.controls[0] as HTMLElement, "Escape");
    expect(f.dismissed.count).toBe(1);
  });

  test("outside the drawer layout nothing is trapped", () => {
    const f = fixture();
    f.modal.sync(true, false);
    const last = f.controls[2] as HTMLElement;
    last.focus();
    expect(press(last, "Tab").defaultPrevented).toBe(false);
  });
});

describe("focus that leaves the panel", () => {
  test("a page element that takes focus is sent back to the control that had it", () => {
    const f = fixture();
    f.modal.sync(true, true);
    const second = f.controls[1] as HTMLElement;
    second.focus();
    f.pageButton.focus();
    expect(f.root.activeElement).toBe(second);
  });

  test("the launcher under the scrim is sent back too", () => {
    const f = fixture();
    f.modal.sync(true, true);
    const first = f.controls[0] as HTMLElement;
    first.focus();
    f.layer.querySelector<HTMLElement>(".button")?.focus();
    expect(f.root.activeElement).toBe(first);
  });

  test("a prompt mounted in the layer keeps the focus it takes", () => {
    const f = fixture();
    f.modal.sync(true, true);
    const prompt = page.document.createElement("div");
    prompt.className = "prompt";
    const approve = button("approve", prompt);
    f.layer.append(prompt);
    approve.focus();
    expect(f.root.activeElement).toBe(approve);
  });

  test("page focus is free again once the drawer is not the active layout", () => {
    const f = fixture();
    f.modal.sync(true, true);
    f.modal.sync(true, false);
    f.pageButton.focus();
    expect(page.document.activeElement).toBe(f.pageButton);
  });
});

describe("returning focus", () => {
  test("closing the drawer hands focus back to the page element that had it when it opened", () => {
    const f = fixture();
    f.pageButton.focus();
    f.modal.sync(true, true);
    (f.controls[0] as HTMLElement).focus();
    f.modal.sync(false, false);
    expect(f.modal.restoreFocus()).toBe(true);
    expect(page.document.activeElement).toBe(f.pageButton);
    // One close, one return.
    expect(f.modal.restoreFocus()).toBe(false);
  });

  test("opened from the launcher there is nothing to return to: the caller falls back to the launcher", () => {
    const f = fixture();
    f.layer.querySelector<HTMLElement>(".button")?.focus();
    f.modal.sync(true, true);
    f.modal.sync(false, false);
    expect(f.modal.restoreFocus()).toBe(false);
  });

  test("an opener the page removed returns nothing", () => {
    const f = fixture();
    f.pageButton.focus();
    f.modal.sync(true, true);
    f.pageButton.remove();
    f.modal.sync(false, false);
    expect(f.modal.restoreFocus()).toBe(false);
  });

  test("a close from the full page does not return focus to the page, even if the drawer was used first", () => {
    const f = fixture();
    f.pageButton.focus();
    f.modal.sync(true, true);
    f.modal.sync(true, false);
    f.modal.sync(false, false);
    expect(f.modal.restoreFocus()).toBe(false);
  });
});

describe("aria-modal follows the layout", () => {
  test("true as the drawer, false as the page, and back", () => {
    const panel = createPanel({ onClose() {}, onEscape() {}, onLayout() {}, onNavigate() {} });
    expect(panel.el.getAttribute("aria-modal")).toBe("true");
    panel.setLayout("page", { showLayoutToggle: true, phone: false });
    expect(panel.el.getAttribute("aria-modal")).toBe("false");
    panel.setLayout("drawer", { showLayoutToggle: true, phone: false });
    expect(panel.el.getAttribute("aria-modal")).toBe("true");
  });
});
