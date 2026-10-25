import { describe, expect, test } from "bun:test";

import { STRINGS, hasString, text } from "../../src/ui/strings";

const REASON_CODES = [
  "unsupported-browser",
  "no-eligible-scope",
  "consent-declined",
  "storage-blocked",
  "erase-pending",
  "budget-reached",
  "signed-out",
  "stale-tab",
  "wipe-failed",
  "session-expired",
];

describe("reason copy", () => {
  test("every known reason code has a copy key", () => {
    for (const code of REASON_CODES) {
      expect(hasString(`sync.reason.${code}`)).toBe(true);
    }
  });

  test("unknown reason codes render the neutral line, never the raw code", () => {
    const rendered = text("sync.reason.made-up-code");
    expect(rendered).toBe(STRINGS["sync.reason.unknown"]);
    expect(rendered).not.toContain("made-up-code");
  });

  test("budget-reached never says storage full", () => {
    expect(STRINGS["sync.reason.budget-reached"].toLowerCase()).not.toContain("storage full");
  });
});

describe("text lookup", () => {
  test("returns the copy for a known key", () => {
    expect(text("panel.title")).toBe("TinyCloud");
  });

  test("the wipe note is the agreed line", () => {
    expect(text("sync.wipe.note")).toBe(
      "Erases TinyCloud's copy on this device. Your data stays on your TinyCloud; the app's own files are not touched.",
    );
  });

  test("unknown keys never echo the input", () => {
    expect(text("<script>")).not.toContain("<script>");
  });
});
