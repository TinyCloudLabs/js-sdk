import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// TC-3278: the first error an agent sees on a computer that is not signed in names the cause and the one command
// that fixes it, in the CLI's own invocation form.
const ENTRY = resolve(import.meta.dir, "..", "index.ts");
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the not-signed-in error", () => {
  test("says the computer isn't signed in and points at onboard, with exit code 3", () => {
    const home = mkdtempSync(join(tmpdir(), "tc-sign-in-error-"));
    made.push(home);
    const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
    const result = spawnSync("bun", [ENTRY, "--json", "kv", "list"], {
      encoding: "utf-8",
      env: { ...ambient, HOME: home, TC_HOME: join(home, "tc") },
    });
    expect(result.status).toBe(3);
    const { error } = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.message).toMatch(/^This computer isn't signed in\. `(tinycloud|tc|npx -y @tinycloud\/cli@\S+) onboard` asks the owner for approval and waits for it\.$/);
    expect(error.message).not.toMatch(/auth login|init|Not authenticated/);
  });
});
