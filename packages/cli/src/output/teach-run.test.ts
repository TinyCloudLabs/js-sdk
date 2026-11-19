import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aboutText } from "./teach.js";

// TC-3278: the first-run text comes after the first command that succeeds, never before an error, so the one JSON
// document an error leaves on stderr stays parseable. These run the real CLI from source in an empty home.
const root = join(import.meta.dir, "../../../..");
const entry = join(import.meta.dir, "../index.ts");
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(home: string, args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  const child = Bun.spawn(["bun", entry, ...args], {
    cwd: root,
    env: { ...process.env, HOME: home, TC_HOME: home, TC_HIDE_BANNER: "", TINYCLOUD_CLI_LOGS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

const taughtPath = (home: string) => join(home, ".tinycloud", "taught.json");

describe("the first-run text in a real run", () => {
  test("a failing first command leaves stderr as one JSON document and does not use up the text", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-teach-run-"));
    made.push(home);
    const failed = await run(home, ["--profile", "nope", "share", "revoke", "abc"]);
    expect(failed.exit).toBe(1);
    expect(() => JSON.parse(failed.stderr)).not.toThrow();
    expect(failed.stderr).not.toContain("TinyCloud stores the owner's data");
    expect(existsSync(taughtPath(home))).toBe(false);
  });

  test("the first command that succeeds prints it after its own output, once", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-teach-run-"));
    made.push(home);
    const first = await run(home, ["skill", "save", "--agent", "claude-code"]);
    expect(first.exit).toBe(0);
    expect(JSON.parse(first.stdout)).toBeDefined();
    // Run from source the CLI names itself `tc`; the text is the same with that name.
    expect(first.stderr).toContain(aboutText("tc", false));
    expect(first.stderr.startsWith("TinyCloud stores")).toBe(false);
    expect(existsSync(taughtPath(home))).toBe(true);
    const second = await run(home, ["skill", "save", "--agent", "claude-code"]);
    expect(second.exit).toBe(0);
    expect(second.stderr).not.toContain("TinyCloud stores the owner's data");
  });
});
