import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { canRenderUi } from "../../src/ui/frame-guard";

type Win = { top: unknown; location: { origin: string } };

const g = globalThis as unknown as { window?: unknown; document?: unknown };

function installPage(win: Win): void {
  g.window = win;
  g.document = {};
}

describe("canRenderUi", () => {
  let savedWindow: unknown;
  let savedDocument: unknown;

  beforeEach(() => {
    savedWindow = g.window;
    savedDocument = g.document;
  });

  afterEach(() => {
    g.window = savedWindow;
    g.document = savedDocument;
  });

  test("true for a top-level page with a real origin", () => {
    const win: Win = { top: undefined, location: { origin: "https://app.example" } };
    win.top = win;
    installPage(win);
    expect(canRenderUi()).toBe(true);
  });

  test("false when the page is inside any frame", () => {
    const top = { location: { origin: "https://parent.example" } };
    const win: Win = { top, location: { origin: "https://child.example" } };
    installPage(win);
    expect(canRenderUi()).toBe(false);
  });

  test("false for an opaque origin", () => {
    const win: Win = { top: undefined, location: { origin: "null" } };
    win.top = win;
    installPage(win);
    expect(canRenderUi()).toBe(false);
  });

  test("false when accessing window properties throws", () => {
    const win = {
      get top(): unknown {
        throw new Error("SecurityError");
      },
      location: { origin: "https://app.example" },
    };
    installPage(win as Win);
    expect(canRenderUi()).toBe(false);
  });

  test("false without a document", () => {
    g.window = { top: undefined, location: { origin: "https://app.example" } };
    (g.window as Win).top = g.window;
    g.document = undefined;
    expect(canRenderUi()).toBe(false);
  });
});
