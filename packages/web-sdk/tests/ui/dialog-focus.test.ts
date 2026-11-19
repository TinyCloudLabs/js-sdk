/**
 * Pure Tab-cycle arithmetic for the prompt dialogs. Focus placement, the Tab
 * trap, and focus return need a real layout engine, so they are covered in
 * `e2e/prompts.pw.ts`.
 */

import { describe, expect, test } from "bun:test";
import { nextTabIndex } from "../../src/notifications/dialogFocus";

describe("nextTabIndex", () => {
  test("Tab advances to the next control", () => {
    expect(nextTabIndex(3, 0, false)).toBe(1);
    expect(nextTabIndex(3, 1, false)).toBe(2);
  });

  test("Tab from the last control wraps to the first", () => {
    expect(nextTabIndex(3, 2, false)).toBe(0);
  });

  test("Tab from the dialog container (no control focused) starts at the first control", () => {
    expect(nextTabIndex(3, -1, false)).toBe(0);
  });

  test("Shift+Tab moves to the previous control", () => {
    expect(nextTabIndex(3, 2, true)).toBe(1);
  });

  test("Shift+Tab from the first control wraps to the last", () => {
    expect(nextTabIndex(3, 0, true)).toBe(2);
  });

  test("Shift+Tab from the dialog container starts at the last control", () => {
    expect(nextTabIndex(3, -1, true)).toBe(2);
  });

  test("a single control stays on itself in both directions", () => {
    expect(nextTabIndex(1, 0, false)).toBe(0);
    expect(nextTabIndex(1, 0, true)).toBe(0);
  });

  test("no controls yields -1 so the trap leaves focus alone", () => {
    expect(nextTabIndex(0, -1, false)).toBe(-1);
    expect(nextTabIndex(0, -1, true)).toBe(-1);
  });
});
