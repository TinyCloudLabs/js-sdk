import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// TC-2299: `--timeout` on `onboard` and `auth grant` is checked before anything else happens, so a bad
// value never creates a profile, reads the request, or contacts a server. Each case spawns the real CLI.

const cliEntry = join(import.meta.dir, "../index.ts");
let home: string;

async function cli(args: string[], stdin = "") {
  const child = Bun.spawn([process.execPath, "--no-env-file", cliEntry, ...args], {
    cwd: home, stdin: new Blob([stdin]),
    env: { PATH: process.env.PATH, HOME: home, TC_HOME: join(home, "tc"), TMPDIR: home, TC_AUTH_NO_POPUP: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

beforeAll(() => {
  home = mkdtempSync("/var/tmp/TC2299-timeout-cli-");
  mkdirSync(join(home, "tc"), { mode: 0o700 });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const commands: Array<[string, string[]]> = [
  ["onboard", ["onboard"]],
  ["auth grant", ["auth", "grant", "missing-request.json"]],
];

describe.each(commands)("%s --timeout", (_name, base) => {
  test.each(["10m", "541s", "60m"])("refuses %s above the 9 minute maximum with exit 2 and says what to do", async (value) => {
    const result = await cli([...base, "--timeout", value]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).not.toContain("pending");
    expect(result.stderr + result.stdout).toContain("INVALID_TIMEOUT");
    expect(result.stderr + result.stdout).toContain("at most 9m");
    expect(result.stderr + result.stdout).toMatch(/run it again/i);
  });

  test.each(["0", "0s", "0m", "-5m", "abc", "1.5m", "5", ""])("refuses %p with exit 2", async (value) => {
    const result = await cli([...base, "--timeout", value]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr + result.stdout).toContain("INVALID_TIMEOUT");
    expect(result.stdout).not.toContain("pending");
  });

  test("a refused value changes nothing on disk: no profile, key or pending approval", async () => {
    const before = readdirSync(join(home, "tc")).sort();
    expect((await cli([...base, "--timeout", "10m"])).exitCode).toBe(2);
    expect(readdirSync(join(home, "tc")).sort()).toEqual(before);
  });

  test("--help documents the option, its limit and the exit 8 JSON", async () => {
    const result = await cli([...base, "--help"]);
    expect(result.exitCode).toBe(0);
    // Help wraps long lines; compare the text with its whitespace collapsed.
    const help = result.stdout.replace(/\s+/g, " ");
    expect(help).toContain("--timeout <duration>");
    expect(help).toContain("at most 9m");
    expect(help).toContain('{"pending":{"step","of","approvalUrl","expiresAt"}}');
    expect(help).toMatch(/exits 8/i);
    expect(help).toContain("run the same command again");
  });
});

test("`auth grant` checks --timeout before it reads its request, so a bad value never consumes stdin", async () => {
  const result = await cli(["auth", "grant", "--stdin", "--timeout", "10m"], "{not json");
  expect(result.exitCode).toBe(2);
  expect(result.stderr + result.stdout).toContain("INVALID_TIMEOUT");
  expect(result.stderr + result.stdout).not.toContain("INVALID_AUTH_REQUEST");
});

test("a valid --timeout is not refused as a usage error", async () => {
  const result = await cli(["auth", "grant", "missing-request.json", "--timeout", "90s"]);
  expect(result.stderr + result.stdout).not.toContain("INVALID_TIMEOUT");
});
