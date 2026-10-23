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
      label: "Storage",
      sublabel: "Usage and limits",
      status: "On",
      onOpen: () => {
        opened += 1;
      },
    });
    const bare = glanceRow({ label: "Activity", sublabel: "Recent events", onOpen: () => undefined });

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
