import { describe, expect, test } from "bun:test";

import { entriesForSigning, finalizeSigningEntries } from "./apps-agent-preset.js";
import { invalidSpaceError } from "./space.js";

const OWNER_APPS = "tinycloud:pkh:eip155:1:0xabc:applications";

// Text a hostile request file can carry: clear screen, an OSC title with BEL, NUL, a right-to-left override, CR.
const HOSTILE = "\u001b[2J\u001b]0;owned\u0007\u0000\u202e\rx";
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

function expectEscaped(message: string): void {
  expect(message).not.toMatch(RAW_CONTROL);
  expect(message).toContain("\\u{1b}[2J");
  expect(message).toContain("\\u{202e}");
  expect(message).toContain("\\u{0}");
}

describe("every refusal that echoes request text escapes it", () => {
  test("Invalid space (space.ts, before any listing or prompt)", () => {
    expectEscaped(invalidSpaceError(`bad ${HOSTILE}`).message);
  });

  test("a service the signer cannot sign (the signer's own message would print it raw after the owner answered y)", () => {
    expectEscaped(messageOf(() => finalizeSigningEntries([
      { service: `tinycloud.${HOSTILE}`, space: "tinycloud:pkh:eip155:1:0xabc:applications", path: "", actions: ["tinycloud.x/get"] },
    ])));
  });

  test("an entry whose space does not resolve", () => {
    expectEscaped(messageOf(() => finalizeSigningEntries([
      { service: "tinycloud.kv", space: HOSTILE, path: "", actions: ["tinycloud.kv/get"] },
    ])));
  });

  test("several spaces in one request", () => {
    expectEscaped(messageOf(() => finalizeSigningEntries([
      { service: "tinycloud.kv", space: "tinycloud:pkh:eip155:1:0xabc:applications", path: "", actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.kv", space: `tinycloud:pkh:eip155:1:0xabc:${HOSTILE}`, path: "", actions: ["tinycloud.kv/get"] },
    ])));
  });

  test("refusals that carry no request text stay plain", () => {
    expect(messageOf(() => entriesForSigning([{ service: "tinycloud.vault", path: "x/", actions: ["del"] }]))).toContain("the vault");
    expect(messageOf(() => entriesForSigning([{ service: "tinycloud.kv", space: "", path: "", actions: ["get"] }]))).toContain("empty space");
  });
});

describe("refusals stay short however much request text they would echo", () => {
  const MAX = 1024;

  test("41 different spaces: at most 5 are shown, the rest counted", () => {
    const entries = Array.from({ length: 41 }, (_, index) => ({
      service: "tinycloud.kv", space: `tinycloud:pkh:eip155:1:0xabc:space${index}`, path: "", actions: ["tinycloud.kv/get"],
    }));
    const message = messageOf(() => finalizeSigningEntries(entries));
    expect(message.length).toBeLessThanOrEqual(MAX);
    expect(message).toContain("41 different spaces");
    expect(message).toContain("and 36 more");
    expect(message).toContain("space0");
    expect(message).not.toContain("space6");
  });

  test("a 5,000-character service name or space is cut to 80 characters with an ellipsis", () => {
    const service = messageOf(() => finalizeSigningEntries([
      { service: `tinycloud.${"x".repeat(5000)}`, space: OWNER_APPS, path: "", actions: ["tinycloud.x/get"] },
    ]));
    expect(service.length).toBeLessThanOrEqual(MAX);
    expect(service).toContain("…");
    const space = messageOf(() => finalizeSigningEntries([
      { service: "tinycloud.kv", space: "y".repeat(5000), path: "", actions: ["tinycloud.kv/get"] },
    ]));
    expect(space.length).toBeLessThanOrEqual(MAX);
    expect(space).toContain("…");
    expect(messageOf(() => { throw invalidSpaceError("z".repeat(5000)); }).length).toBeLessThanOrEqual(MAX);
  });

  test("1,000 entries and 41 hostile spaces with long names together still give one short message", () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      service: "tinycloud.kv",
      space: index < 41 ? `tinycloud:pkh:eip155:1:0xabc:${HOSTILE}${"n".repeat(200)}${index}` : OWNER_APPS,
      path: `app${index}/`,
      actions: ["tinycloud.kv/get"],
    }));
    const message = messageOf(() => finalizeSigningEntries(entries));
    expect(message.length).toBeLessThanOrEqual(MAX);
    expect(message).not.toMatch(RAW_CONTROL);
    expect(message).toContain("42 different spaces");
    expect(message).toContain("and 37 more");
  });

  test("a hostile service name keeps the escaping inside the clip", () => {
    const message = messageOf(() => finalizeSigningEntries([
      { service: `tinycloud.${HOSTILE.repeat(100)}`, space: OWNER_APPS, path: "", actions: ["tinycloud.x/get"] },
    ]));
    expect(message.length).toBeLessThanOrEqual(MAX);
    expect(message).not.toMatch(RAW_CONTROL);
    expect(message).toContain("\\u{1b}[2J");
  });
});
