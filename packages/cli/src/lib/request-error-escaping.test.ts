import { describe, expect, test } from "bun:test";

import { entriesForSigning, finalizeSigningEntries } from "./apps-agent-preset.js";
import { invalidSpaceError } from "./space.js";

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
    expect(messageOf(() => entriesForSigning([{ service: "tinycloud.vault", path: "x/", actions: ["del"] }]))).toContain("vault access");
    expect(messageOf(() => entriesForSigning([{ service: "tinycloud.kv", space: "", path: "", actions: ["get"] }]))).toContain("empty space");
  });
});
