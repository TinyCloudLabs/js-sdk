import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// TC-3278: `skill save` ends by sending the agent back to the owner's request, and only when it saved.
const ENTRY = resolve(import.meta.dir, "..", "index.ts");
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]): { status: number | null; stderr: string; stdout: string } {
  const home = mkdtempSync(join(tmpdir(), "tc-skill-next-"));
  made.push(home);
  mkdirSync(join(home, ".claude"));
  const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, TC_HIDE_BANNER: _banner, ...ambient } = process.env;
  const result = spawnSync("bun", [ENTRY, "skill", "save", ...args], {
    encoding: "utf-8",
    env: { ...ambient, HOME: home, TC_HOME: join(home, "tc"), TC_HIDE_BANNER: "1" },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

const nextLines = (stderr: string): string[] => stderr.split("\n").filter((line) => line.startsWith("Next:"));

describe("the Next: line after skill save", () => {
  test("is one line on stderr after a save, and stdout stays the JSON result", () => {
    const result = run("--agent", "claude-code");
    expect(result.status).toBe(0);
    expect(nextLines(result.stderr)).toEqual(["Next: carry on with the owner's request."]);
    expect(JSON.parse(result.stdout)).toMatchObject({ saved: "tinycloud-cli" });
  });

  test("is not printed with --quiet", () => {
    const result = run("--agent", "claude-code", "--quiet");
    expect(result.status).toBe(0);
    expect(nextLines(result.stderr)).toEqual([]);
  });

  test("is not printed by --check, which saves nothing", () => {
    const result = run("--agent", "claude-code", "--check");
    expect(result.status).toBe(0);
    expect(nextLines(result.stderr)).toEqual([]);
  });

  test("is not printed when the save fails", () => {
    const result = run("--agent", "no-such-client");
    expect(result.status).not.toBe(0);
    expect(nextLines(result.stderr)).toEqual([]);
  });
});
