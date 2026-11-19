import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { createSectionDialogs } from "../../src/ui/section-dialogs";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "KeyboardEvent"];
const saved = new Map<string, unknown>();
let page: Window;

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
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

afterEach(() => {
  page.document.body.innerHTML = "";
});

function setup() {
  const host = page.document.createElement("section");
  const first = page.document.createElement("button");
  const last = page.document.createElement("p");
  host.append(first, last);
  page.document.body.append(host);
  return { host: host as unknown as HTMLElement, first: first as unknown as HTMLElement, last: last as unknown as HTMLElement };
}

const request = (extra: Record<string, unknown> = {}) => ({
  question: "Revoke this?",
  cancelLabel: "Keep",
  confirmLabel: "Revoke",
  onConfirm: () => undefined,
  ...extra,
});

describe("ctx.confirm", () => {
  test("lands at the end of the section, or after the anchor, with the safe action focused", () => {
    const { host, first } = setup();
    const dialogs = createSectionDialogs(() => host);
    const atEnd = dialogs.confirm(request());
    expect(host.lastElementChild?.getAttribute("role")).toBe("alertdialog");
    expect(page.document.activeElement).toBe(atEnd.cancel as unknown as Element);
    atEnd.close();

    dialogs.confirm(request({ anchor: first }));
    expect(first.nextElementSibling?.getAttribute("role")).toBe("alertdialog");
  });

  test("the safe action closes the box and reports once; the destructive action leaves it open until close()", () => {
    const { host } = setup();
    const dialogs = createSectionDialogs(() => host);
    const calls: string[] = [];
    const handle = dialogs.confirm(request({ onCancel: () => calls.push("cancel"), onConfirm: () => calls.push("confirm") }));
    handle.confirm.click();
    expect(calls).toEqual(["confirm"]);
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    handle.cancel.click();
    handle.cancel.click();
    expect(calls).toEqual(["confirm", "cancel"]);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  test("Escape takes the safe action", () => {
    const { host } = setup();
    const dialogs = createSectionDialogs(() => host);
    const calls: string[] = [];
    dialogs.confirm(request({ onCancel: () => calls.push("cancel"), onConfirm: () => calls.push("confirm") }));
    host
      .querySelector('[role="alertdialog"]')
      ?.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    expect(calls).toEqual(["cancel"]);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  test("close() removes the box without reporting a cancel", () => {
    const { host } = setup();
    const dialogs = createSectionDialogs(() => host);
    const calls: string[] = [];
    dialogs.confirm(request({ onCancel: () => calls.push("cancel") })).close();
    expect(calls).toEqual([]);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });
});

describe("ctx.openDrawer", () => {
  const drawer = (extra: Record<string, unknown> = {}) => {
    const body = page.document.createElement("p");
    body.textContent = "Details";
    return { title: "Access", body: [body as unknown as Node], closeLabel: "Close", ...extra };
  };

  test("renders title and body, moves focus to the heading, and the Close action closes it once", () => {
    const { host } = setup();
    const dialogs = createSectionDialogs(() => host);
    let closed = 0;
    const handle = dialogs.openDrawer(drawer({ onClose: () => (closed += 1) }));
    expect(handle.el.querySelector("h3")?.textContent).toBe("Access");
    expect(page.document.activeElement).toBe(handle.el.querySelector("h3") as unknown as Element);
    handle.el.querySelector<HTMLButtonElement>("button")?.click();
    handle.close();
    expect(closed).toBe(1);
    expect(host.querySelector(".drawer")).toBeNull();
  });

  test("is placed after its anchor", () => {
    const { host, first } = setup();
    createSectionDialogs(() => host).openDrawer(drawer({ anchor: first }));
    expect(first.nextElementSibling?.className).toBe("drawer");
  });
});

describe("closeAll", () => {
  test("removes every open box and drawer silently", () => {
    const { host } = setup();
    const dialogs = createSectionDialogs(() => host);
    const calls: string[] = [];
    dialogs.confirm(request({ onCancel: () => calls.push("cancel") }));
    dialogs.openDrawer({ title: "T", body: [], closeLabel: "Close", onClose: () => calls.push("close") });
    dialogs.closeAll();
    expect(calls).toEqual([]);
    expect(host.querySelector('[role="alertdialog"], .drawer')).toBeNull();
  });
});
