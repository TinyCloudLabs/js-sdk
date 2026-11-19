import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { confirmBox, detailsDrawer, glanceRow } from "../../src/ui/sections/ui";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent"];
const saved = new Map<string, unknown>();

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  const page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Node = page.Node;
  g.Event = page.Event;
  g.MouseEvent = page.MouseEvent;
  g.KeyboardEvent = page.KeyboardEvent;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

describe("confirmBox", () => {
  test("the safe action comes first and is the one the caller focuses", () => {
    const box = confirmBox({
      question: "Sign out?",
      cancelLabel: "Stay signed in",
      confirmLabel: "Sign out",
      onCancel: () => undefined,
      onConfirm: () => undefined,
    });

    const buttons = Array.from(box.el.querySelectorAll("button"));
    expect(buttons[0]).toBe(box.cancel);
    expect(buttons[1]).toBe(box.confirm);
    expect(box.cancel.textContent).toBe("Stay signed in");
    expect(box.el.getAttribute("role")).toBe("alertdialog");
  });

  test("each button calls only its own callback", () => {
    const calls: string[] = [];
    const box = confirmBox({
      question: "Sign out?",
      cancelLabel: "Stay signed in",
      confirmLabel: "Sign out",
      onCancel: () => calls.push("cancel"),
      onConfirm: () => calls.push("confirm"),
    });

    box.cancel.click();
    box.confirm.click();
    expect(calls).toEqual(["cancel", "confirm"]);
  });

  test("confirmBox exposes its question as the accessible description", () => {
    const box = confirmBox({
      question: "Wiping now loses 3 unsynced changes.",
      cancelLabel: "Keep",
      confirmLabel: "Wipe",
      onCancel: () => undefined,
      onConfirm: () => undefined,
    });
    g.document.body.append(box.el);
    const describedBy = box.el.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const target = g.document.getElementById(describedBy as string);
    expect(target).not.toBeNull();
    expect(box.el.contains(target as Element)).toBe(true);
    expect(target?.textContent).toBe("Wiping now loses 3 unsynced changes.");
    box.el.remove();
  });

  test("two confirm boxes get different description ids", () => {
    const make = () =>
      confirmBox({ question: "Sure?", cancelLabel: "No", confirmLabel: "Yes", onCancel: () => undefined, onConfirm: () => undefined });
    const a = make();
    const b = make();
    g.document.body.append(a.el, b.el);
    expect(a.el.getAttribute("aria-describedby")).not.toBe(b.el.getAttribute("aria-describedby"));
    expect(g.document.getElementById(b.el.getAttribute("aria-describedby") as string)?.parentElement).toBe(b.el);
    a.el.remove();
    b.el.remove();
  });

  test("Escape is ignored while the confirm's action is running, works after it settles", () => {
    const calls: string[] = [];
    const box = confirmBox({
      question: "Wipe local data?",
      cancelLabel: "Keep",
      confirmLabel: "Wipe",
      onCancel: () => calls.push("cancel"),
      onConfirm: () => calls.push("confirm"),
    });
    const panelKeys: string[] = [];
    const panel = g.document.createElement("div");
    panel.addEventListener("keydown", () => panelKeys.push("reached panel"));
    panel.append(box.el);
    g.document.body.append(panel);
    const escape = () => box.el.dispatchEvent(new g.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    // The caller disables both actions while the destructive work runs.
    box.cancel.disabled = true;
    box.confirm.disabled = true;
    escape();
    expect(calls).toEqual([]);
    expect(panel.contains(box.el)).toBe(true);
    expect(panelKeys).toEqual([]);

    box.cancel.disabled = false;
    box.confirm.disabled = false;
    escape();
    expect(calls).toEqual(["cancel"]);
    panel.remove();
  });

  test("Escape takes the safe action and does not reach the panel's own handler", () => {
    const calls: string[] = [];
    const box = confirmBox({
      question: "Sign out?",
      cancelLabel: "Stay signed in",
      confirmLabel: "Sign out",
      onCancel: () => calls.push("cancel"),
      onConfirm: () => calls.push("confirm"),
    });
    const panelKeys: string[] = [];
    const panel = g.document.createElement("div");
    panel.addEventListener("keydown", () => panelKeys.push("reached panel"));
    panel.append(box.el);

    box.el.dispatchEvent(new g.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(calls).toEqual(["cancel"]);
    expect(panelKeys).toEqual([]);
  });
});

describe("glanceRow", () => {
  test("is a button that opens once per click and shows its status only when given", () => {
    let opened = 0;
    const withStatus = glanceRow({
      icon: "monitor",
      label: "Storage",
      sublabel: "Usage and limits",
      status: { text: "On", tone: "ok" },
      onOpen: () => {
        opened += 1;
      },
    });
    const bare = glanceRow({ icon: "monitor", label: "Activity", sublabel: "Recent events", onOpen: () => undefined });

    expect(withStatus.tagName).toBe("BUTTON");
    expect(withStatus.textContent).toContain("On");
    expect(bare.textContent).not.toContain("On");
    withStatus.click();
    expect(opened).toBe(1);
  });
});

describe("detailsDrawer", () => {
  test("renders its title and body in order, and close calls onClose", () => {
    let closed = 0;
    const first = document.createElement("p");
    first.textContent = "First";
    const second = document.createElement("p");
    second.textContent = "Second";
    const drawer = detailsDrawer({
      title: "Details",
      body: [first, second],
      closeLabel: "Close",
      onClose: () => {
        closed += 1;
      },
    });

    expect(drawer.querySelector("h3")?.textContent).toBe("Details");
    const text = Array.from(drawer.querySelectorAll("p")).map((p) => p.textContent);
    expect(text).toEqual(["First", "Second"]);
    drawer.querySelector<HTMLButtonElement>("button")?.click();
    expect(closed).toBe(1);
  });
});
