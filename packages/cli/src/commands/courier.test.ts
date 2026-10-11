import { beforeAll, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_GRANT } from "@tinycloud/courier";
import { registerCourierCommand } from "./courier.ts";

// Runs the built CLI (`bun run --cwd packages/cli build` first) under Node, as users do.
const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

function tc(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "tc-courier-"));
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, TC_HOME: join(home, ".tinycloud"), COURIER_HOME: join(home, ".courier"), NO_COLOR: "1" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, home };
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

  for (const argv of [
    ["--profile", "p", "courier", "manifest"],
    ["-vp", "p", "courier", "manifest"],
    ["-qH", "https://node.example", "courier", "manifest"],
    ["-vpp", "courier", "manifest"],
    ["-Hhttps://node.example", "courier", "manifest"],
    ["--profile=p", "courier", "manifest"],
    ["--json", "courier", "manifest"],
    ["--", "courier", "manifest"],
    ["-v", "--", "courier", "manifest"],
  ]) {
    test(`tc ${argv.join(" ")} is rejected`, () => {
      const result = tc(argv);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("~/.courier");
    });
  }

  test("tc options before courier never let tc consume Courier's --host", () => {
    const result = tc(["-vp", "p", "courier", "init", "--request", "--host", "https://node.example"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(existsSync(join(result.home, ".courier"))).toBe(false);
  });

  test("the Commander courier command refuses instead of running Courier", async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} })
      .option("-H, --host <url>");
    registerCourierCommand(program);
    await expect(program.parseAsync(["courier", "init", "--request", "--host", "https://node.example"], { from: "user" }))
      .rejects.toMatchObject({ exitCode: 2, code: "tc.courier.options" });
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

