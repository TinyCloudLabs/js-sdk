#!/usr/bin/env node
// Runs the built CLI (packages/cli/bin/tinycloud) under the Node that runs this
// script, which must be Node 20, for offline commands (TC-4279). `bun test`
// runs in-process code under Bun, so only a real Node 20 process catches an API
// that Node 20 lacks.
//
//   bun run --cwd packages/cli build && node .github/scripts/cli-node20-smoke.mjs
//
// Each command runs with an empty profile directory and no network. A case
// fails on the wrong exit code, the wrong output, or any `TypeError` / `ERR_*`
// in its output.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [major] = process.versions.node.split(".").map(Number);
if (major !== 20) {
  console.error(`::error::run this on Node 20; this is Node ${process.versions.node}`);
  process.exit(2);
}

const cliDir = fileURLToPath(new URL("../../packages/cli/", import.meta.url));
const bin = join(cliDir, "bin/tinycloud");
const { version } = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const home = mkdtempSync(join(tmpdir(), "cli-node20-smoke-"));

// A replication controller whose close never settles, put where the CLI's
// replication registry looks for its state. After the command finishes,
// closeReplication() gives up after 3 s and the CLI flushes stdio and exits:
// the path that used Promise.withResolvers (TC-4279).
const stuckReplication = join(home, "stuck-replication.mjs");
writeFileSync(stuckReplication, `const control = { close: () => new Promise(() => {}) };
globalThis[Symbol.for("@tinycloud/cli/replication-registry")] = {
  controls: new Map([["default", control]]), allControls: new Set([control]), installedSignalHandlers: false, generation: 1,
};
`);

function run(args, nodeArgs = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, bin, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, TC_HOME: join(home, "tc"), TMPDIR: home, TINYCLOUD_CLI_LOGS: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const cases = [
  ["--version prints the package version", ["--version"], (r) => r.status === 0 && r.stdout.trim() === version],
  ["--help prints usage", ["--help"], (r) => r.status === 0 && r.stdout.includes("Usage: tinycloud")],
  ["an unknown command exits 1", ["definitely-not-a-command"], (r) => r.status === 1 && r.stderr.includes("unknown command")],
  ["courier --help prints usage", ["courier", "--help"], (r) => r.status === 0 && r.stdout.includes("tinycloud courier")],
  ["a --json error is one JSON object on stderr", ["--json", "auth", "grant", "missing-request.json"], (r) => {
    if (r.status === 0 || r.stdout !== "") return false;
    try {
      return typeof JSON.parse(r.stderr).error?.code === "string";
    } catch {
      return false;
    }
  }],
  ["a command whose replication close times out still exits 0", ["--json", "profile", "list"], (r) => {
    try {
      return r.status === 0 && Array.isArray(JSON.parse(r.stdout).profiles);
    } catch {
      return false;
    }
  }, ["--import", pathToFileURL(stuckReplication).href]],
];

let failed = 0;
try {
  console.log(`Node ${process.versions.node}, ${bin} (${version})`);
  for (const [name, args, ok, nodeArgs] of cases) {
    const result = run(args, nodeArgs);
    const crashed = /\bTypeError\b|\bERR_[A-Z0-9_]+\b/.exec(result.stdout + result.stderr);
    if (ok(result) && !crashed) {
      console.log(`ok   ${name}`);
      continue;
    }
    failed += 1;
    console.error(`::error::${name}: tinycloud ${args.join(" ")} exited ${result.status ?? result.signal}${crashed ? `, output has ${crashed[0]}` : ""}`);
    console.error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
