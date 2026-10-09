import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_GRANT } from "@tinycloud/courier";

// Runs the built CLI (`bun run --cwd packages/cli build` first) under Node, as users do.
const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

function tc(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "tc-courier-"));
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, TC_HOME: join(home, ".tinycloud"), COURIER_HOME: join(home, ".courier"), NO_COLOR: "1" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("tc courier", () => {
  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} is missing.`);
  });

  test("--help prints Courier usage without the tc banner", () => {
    const result = tc(["courier", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("tc courier —")).toBe(true);
    expect(result.stderr).toBe("");
  });

  test("manifest prints the bundled Courier agent grant", () => {
    const result = tc(["courier", "manifest"]);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.space).toBe("agents");
    expect(manifest.permissions).toEqual(AGENT_GRANT);
  });

  test("tc options before courier are rejected", () => {
    const result = tc(["--profile", "p", "courier", "manifest"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("~/.courier");
  });

  test("unknown Courier command is a usage error", () => {
    const result = tc(["courier", "frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown command");
  });

  test("errors name tc courier", () => {
    const result = tc(["courier", "init", "--resume"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tc courier: [no-grant]");
    expect(result.stderr).toContain("`tc courier init`");
  });

  test("--host and --openkey-host reach Courier, not tc", () => {
    const result = tc(["courier", "init", "--request", "--host", "https://node.example", "--openkey-host", "https://ok.example"]);
    expect(result.code).toBe(0);
    const request = JSON.parse(result.stdout);
    expect(request.host).toBe("https://node.example");
    expect(request.openkeyUrl.startsWith("https://ok.example/delegate")).toBe(true);
  });

  test("tc --help lists courier", () => {
    const result = tc(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\s+courier \[args\.\.\.\]/m);
  });
});
