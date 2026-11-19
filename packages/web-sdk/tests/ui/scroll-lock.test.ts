import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { acquireScrollLock } from "../../src/notifications/scrollLock";

// The lock only reads and writes `document.body.style.overflow`, so a plain
// object stands in for the DOM.
const globals = globalThis as unknown as Record<string, unknown>;
const savedDocument = globals.document;
const body = { style: { overflow: "" } };

beforeEach(() => {
  globals.document = { body };
  body.style.overflow = "";
});

afterAll(() => {
  globals.document = savedDocument;
});

describe("acquireScrollLock", () => {
  test("hides overflow while held and restores an empty value on release", () => {
    const release = acquireScrollLock();
    expect(body.style.overflow).toBe("hidden");
    release();
    expect(body.style.overflow).toBe("");
  });

  test("restores a page's own overflow:clip rather than clearing it", () => {
    body.style.overflow = "clip";
    const release = acquireScrollLock();
    expect(body.style.overflow).toBe("hidden");
    release();
    expect(body.style.overflow).toBe("clip");
  });

  test("a displaced prompt's release keeps the lock; the last release restores the page value", () => {
    body.style.overflow = "clip";
    const displaced = acquireScrollLock();
    const replacement = acquireScrollLock();
    displaced();
    expect(body.style.overflow).toBe("hidden");
    replacement();
    expect(body.style.overflow).toBe("clip");
  });

  test("releasing the same lock twice does not release another holder", () => {
    body.style.overflow = "clip";
    const first = acquireScrollLock();
    const second = acquireScrollLock();
    first();
    first();
    expect(body.style.overflow).toBe("hidden");
    second();
    expect(body.style.overflow).toBe("clip");
  });
});
