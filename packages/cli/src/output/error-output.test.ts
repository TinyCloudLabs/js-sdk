import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { outputError, outputJson } from "./formatter.js";

// One of every class a hostile string can use to drive a terminal or hide text.
const HOSTILE = "\u001b[2J\u001b]0;owned\u0007\u0000\u202e\u2028\u2066\u009b\u200b\ufeff\r";
// eslint-disable-next-line no-control-regex
const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
// chalk colours the fixed parts of the line; only the hostile payload must not survive
const PAYLOAD = /\u001b\[2J|\u001b\]0;|\u0007|\u0000|\u202e|\u2028|\u2066|\u009b|\u200b|\ufeff/;

const realIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
let written: string[];

function terminal(on: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
}

beforeEach(() => {
  written = [];
  spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  if (realIsTTY) Object.defineProperty(process.stdout, "isTTY", realIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  (process.stderr.write as unknown as { mockRestore(): void }).mockRestore();
});

describe("outputError", () => {
  test("on a terminal, the message, the hint and the code are escaped", () => {
    terminal(true);
    outputError(`CODE${HOSTILE}`, `bad ${HOSTILE} value\nsecond line`, `try ${HOSTILE}\nand ${HOSTILE}`);
    const text = written.join("");
    expect(text).not.toMatch(PAYLOAD);
    expect(text).toContain("\\u{1b}[2J");
    expect(text).toContain("\\u{202e}");
    expect(text).toContain("\\u{2028}");
    expect(text).toContain("\\u{9b}");
    expect(text).toContain("\\u{feff}");
    // legitimate line structure survives
    expect(text).toContain("second line");
    expect(text.split("\n").filter((line) => line.includes("try ") || line.includes("and ")).length).toBe(2);
  });

  test("an ordinary message is printed as written", () => {
    terminal(true);
    outputError("NOT_FOUND", "No such app: xyz.example.app", "Run `tc knowledge list`.");
    const text = written.join("");
    expect(text).toContain("NOT_FOUND");
    expect(text).toContain("No such app: xyz.example.app");
    expect(text).toContain("Run `tc knowledge list`.");
  });

  test("JSON output (stdout redirected, stderr possibly still a terminal) parses to the exact text but carries no raw character", () => {
    terminal(false);
    outputError("CODE", `bad ${HOSTILE}`, `hint ${HOSTILE}`);
    const text = written.join("");
    expect(text.replace(/\n/g, "")).not.toMatch(RAW);
    const parsed = JSON.parse(text) as { error: { message: string; hint: string } };
    expect(parsed.error.message).toBe(`bad ${HOSTILE}`);
    expect(parsed.error.hint).toBe(`hint ${HOSTILE}`);
  });

  test("the JSON success output and the warnings line are terminal-safe too", () => {
    terminal(false);
    const out: string[] = [];
    const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      outputJson({ value: HOSTILE });
    } finally {
      stdout.mockRestore();
    }
    expect(out.join("").replace(/\n/g, "")).not.toMatch(RAW);
    expect((JSON.parse(out.join("")) as { value: string }).value).toBe(HOSTILE);
  });
});
