import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aboutText, showAboutOnce } from "./teach.js";

// TC-3278: the CLI says what it is once, on the first command in a config folder, and never asks anything of the reader.
const root = typeof process.getuid === "function" && process.getuid() === 0;
const made: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tc-teach-"));
  made.push(dir);
  return dir;
};

describe("the about text", () => {
  test("is exactly the approved words, with the sign-in line only when not signed in", () => {
    const first = "TinyCloud stores the owner's data in their own space. Apps and agents reach it only with the owner's approval.";
    const second = "Commands: kv (keys and values), sql (databases), secrets, share (share links), feed (cards on the owner's Feed).";
    expect(aboutText("tinycloud", false)).toBe(
      `${first}\n${second}\n\`tinycloud <command> --help\` explains each one. Output is JSON. \`--profile <name>\` picks the account.\n` +
        "This computer isn't signed in. `tinycloud onboard` asks the owner for approval and waits for it.\n\n",
    );
    expect(aboutText("tinycloud", true)).not.toContain("isn't signed in");
  });

  test("names the command that works on this computer", () => {
    const text = aboutText("npx -y @tinycloud/cli@1.8.0", false);
    expect(text).toContain("`npx -y @tinycloud/cli@1.8.0 <command> --help` explains each one.");
    expect(text).toContain("`npx -y @tinycloud/cli@1.8.0 onboard` asks the owner for approval and waits for it.");
  });

  test("asks for no sudo, install or permission change", () => {
    expect(aboutText("tinycloud", false)).not.toMatch(/sudo|chmod|chown|install|administrator/i);
  });
});

describe("showAboutOnce", () => {
  test("prints on the first call, saves 0600, and is silent after", () => {
    const dir = join(scratch(), "config");
    const out: string[] = [];
    expect(showAboutOnce({ dir, cli: "tinycloud", signedIn: false, write: (text) => out.push(text) })).toBe(true);
    expect(showAboutOnce({ dir, cli: "tinycloud", signedIn: false, write: (text) => out.push(text) })).toBe(false);
    expect(out).toEqual([aboutText("tinycloud", false)]);
    expect(JSON.parse(readFileSync(join(dir, "taught.json"), "utf8"))).toEqual({ about: true });
    if (process.platform !== "win32") expect(statSync(join(dir, "taught.json")).mode & 0o777).toBe(0o600);
  });

  test("keeps what other messages saved", () => {
    const dir = scratch();
    writeFileSync(join(dir, "taught.json"), JSON.stringify({ other: true }));
    showAboutOnce({ dir, cli: "tinycloud", signedIn: true, write: () => undefined });
    expect(JSON.parse(readFileSync(join(dir, "taught.json"), "utf8"))).toEqual({ other: true, about: true });
  });

  test("an unreadable state file counts as nothing shown yet, and is replaced", () => {
    const dir = scratch();
    writeFileSync(join(dir, "taught.json"), "not json");
    const out: string[] = [];
    expect(showAboutOnce({ dir, cli: "tinycloud", signedIn: true, write: (text) => out.push(text) })).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "taught.json"), "utf8"))).toEqual({ about: true });
  });

  test.skipIf(root || process.platform === "win32")("when the state cannot be saved nothing is printed, so it never repeats", () => {
    const parent = scratch();
    chmodSync(parent, 0o555);
    locked.push(parent);
    const out: string[] = [];
    expect(showAboutOnce({ dir: join(parent, "config"), cli: "tinycloud", signedIn: false, write: (text) => out.push(text) })).toBe(false);
    expect(out).toEqual([]);
    expect(existsSync(join(parent, "config"))).toBe(false);
  });
});
