import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GUARD_MARKER, nodeOptionsWithGuard } from "../test-support/production-origin-guard.mjs";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const PRODUCTION_ORIGIN = "https://api.tinycloud.xyz";

// The child reports whether its fetch carries the guard and what a production links POST does. The POST is only
// attempted when `attempt` is true, and only against a guarded fetch: an unguarded child must never reach the network.
const probe = (attempt: boolean) => `
  const guarded = globalThis.fetch.productionOriginGuard === true;
  const result = ${attempt} && guarded
    ? await fetch(${JSON.stringify(`${PRODUCTION_ORIGIN}/v1/links`)}, { method: "POST", body: "{}" }).then(() => "reached", (error) => "refused: " + error.message)
    : "not attempted";
  console.log(JSON.stringify({ guarded, result }));
`;

function childEnvironment(options: { marker: boolean; productionOrigin: boolean }): Record<string, string> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment[GUARD_MARKER];
  delete environment.TC_LINKS_API_ORIGIN;
  delete environment.COURIER_LINKS_API_ORIGIN;
  if (options.marker) environment[GUARD_MARKER] = "1";
  if (options.productionOrigin) environment.TC_LINKS_API_ORIGIN = PRODUCTION_ORIGIN;
  return environment;
}

function run(command: string, args: string[], environment: Record<string, string>, cwd = repositoryRoot) {
  const child = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", timeout: 60_000 });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { guarded: boolean; result: string };
}

describe("production links guard in spawned children", () => {
  test("the test bootstrap marks the test process, so its children are armed", () => {
    expect(process.env[GUARD_MARKER]).toBe("1");
  });

  test("a Bun child started from the repository root refuses the production links API, even when its environment names production as the origin", () => {
    const report = run(process.execPath, ["-e", probe(true)], childEnvironment({ marker: true, productionOrigin: true }));
    expect(report.guarded).toBe(true);
    expect(report.result).toMatch(/^refused: Tests must not use the production links API \(POST https:\/\/api\.tinycloud\.xyz\/v1\/links\)/);
  });

  test("a Bun script file started from the repository root is armed the same way", () => {
    const directory = mkdtempSync(join(tmpdir(), "guard-child-"));
    try {
      const script = join(directory, "probe.mjs");
      writeFileSync(script, probe(true));
      const report = run(process.execPath, [script], childEnvironment({ marker: true, productionOrigin: false }));
      expect(report.guarded).toBe(true);
      expect(report.result).toMatch(/^refused:/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("without the marker a Bun child is not armed: ordinary `bun run` use in the repository is untouched", () => {
    const report = run(process.execPath, ["-e", probe(true)], childEnvironment({ marker: false, productionOrigin: false }));
    expect(report).toEqual({ guarded: false, result: "not attempted" });
  });

  test("a Node child gets the fetch refusal through NODE_OPTIONS and still starts with a production origin variable set; the request is what is refused", () => {
    const environment = { ...childEnvironment({ marker: true, productionOrigin: true }), NODE_OPTIONS: nodeOptionsWithGuard(undefined) };
    const report = run("node", ["--input-type=module", "-e", probe(true)], environment);
    expect(report.guarded).toBe(true);
    expect(report.result).toMatch(/^refused: Tests must not use the production links API/);
  });
});
