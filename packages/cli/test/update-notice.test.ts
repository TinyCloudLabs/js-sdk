import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Runs the built CLI (`bun run --cwd packages/cli build` first) under Node, as users do. The notice is for terminals
// only, so most runs go through util-linux `script`, which gives the CLI a pty.
const PACKAGE_DIR = resolve(import.meta.dir, "..");
const { version: installed, bin } = JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf-8")) as {
  version: string;
  bin: Record<string, string>;
};
const CLI = resolve(PACKAGE_DIR, bin.tinycloud);
const NEWER = installed.replace(/\d+$/, (build) => String(Number(build) + 1));
const CHANNEL = /^[^-+]+-([0-9A-Za-z-]+)/.exec(installed)?.[1] ?? "latest";
const onLinux = process.platform === "linux";

type Home = { home: string; config: string; env: NodeJS.ProcessEnv };

function withHome(run: (home: Home) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-update-notice-"));
    const state = join(home, "state");
    const config = join(state, ".tinycloud");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
    try {
      await run({
        home,
        config,
        env: { ...ambient, CI: "", TC_NO_AUTO_UPDATE: "", NO_COLOR: "1", HOME: home, TC_HOME: state, COURIER_HOME: join(home, ".courier") },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function seedCache(config: string, version: string | null): void {
  writeFileSync(join(config, `update-check.json.${CHANNEL}`), JSON.stringify({ checkedAt: Date.now(), version }), { mode: 0o600 });
}

/** The CLI on a pty: stdout and stderr arrive together. */
function inTerminal(env: NodeJS.ProcessEnv, args: readonly string[]) {
  const command = ["node", CLI, ...args].map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(" ");
  const result = spawnSync("script", ["-qec", command, "/dev/null"], { encoding: "utf-8", env, timeout: 60_000 });
  return { status: result.status, output: result.stdout };
}

test.skipIf(!onLinux)("a successful command in a terminal names the cached newer release", withHome(({ config, env }) => {
  seedCache(config, NEWER);
  for (const args of [["--version"], ["--help"], ["profile", "list"]]) {
    const result = inTerminal(env, args);
    expect({ args, status: result.status }).toEqual({ args, status: 0 });
    expect(result.output).toContain(`TinyCloud CLI ${NEWER} is available. This is ${installed}`);
  }
}), 120_000);

test.skipIf(!onLinux)("--quiet, --json, courier and failing commands never show the notice in a terminal", withHome(({ config, env }) => {
  seedCache(config, NEWER);
  for (const [args, status] of [
    [["--quiet", "--version"], 0],
    [["--json", "profile", "list"], 0],
    [["courier", "manifest"], 0],
    [["no-such-command"], 1],
  ] as const) {
    const result = inTerminal(env, args);
    expect({ args, status: result.status }).toEqual({ args, status });
    expect(result.output).not.toContain(NEWER);
  }
}), 120_000);

test("output that isn't a terminal never shows the notice, and a failing command's stderr stays one JSON error", withHome(({ config, env }) => {
  seedCache(config, NEWER);
  const succeeded = spawnSync("node", [CLI, "--version"], { encoding: "utf-8", env, timeout: 60_000 });
  expect(succeeded.status).toBe(0);
  expect(succeeded.stdout).toContain(installed);
  expect(succeeded.stderr).not.toContain(NEWER);

  const failed = spawnSync("node", [CLI, "--json", "kv", "list"], { encoding: "utf-8", env, timeout: 60_000 });
  expect(failed.status).not.toBe(0);
  expect(JSON.parse(failed.stderr).error.code).toBe("AUTH_REQUIRED");
}), 120_000);

// In the command process every network path records itself and fails; in the background check, fetch answers
// from TC_TEST_DIST_TAGS. Both append to TC_TEST_NETWORK_LOG.
const NETWORK_PRELOAD = `import { appendFileSync } from "node:fs";
import dns from "node:dns";
import net from "node:net";
const log = (line) => appendFileSync(process.env.TC_TEST_NETWORK_LOG, line + "\\n");
if (process.argv[1]?.endsWith("update-check-entry.js")) {
  globalThis.fetch = async (url) => { log("check " + url); return Response.json(JSON.parse(process.env.TC_TEST_DIST_TAGS)); };
} else {
  const deny = (what) => { log("command " + what); throw new Error("network use in the command process"); };
  globalThis.fetch = async () => deny("fetch");
  dns.lookup = () => deny("dns");
  net.Socket.prototype.connect = function () { deny("connect"); };
}
`;

test.skipIf(!onLinux)("the command never uses the network; a background check fills the cache and the next run names the release", withHome(async ({ home, config, env }) => {
  const preload = join(home, "network.mjs");
  const networkLog = join(home, "network.log");
  writeFileSync(preload, NETWORK_PRELOAD);
  writeFileSync(networkLog, "");
  const runEnv = {
    ...env,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    TC_TEST_NETWORK_LOG: networkLog,
    TC_TEST_DIST_TAGS: JSON.stringify({ latest: CHANNEL === "latest" ? NEWER : "0.0.1", [CHANNEL]: NEWER }),
  };

  const first = inTerminal(runEnv, ["--version"]);
  expect(first.status).toBe(0);
  expect(first.output).not.toContain(NEWER);

  // The check runs detached and outlives the command; wait for the cache it writes.
  const cachePath = join(config, `update-check.json.${CHANNEL}`);
  const deadline = Date.now() + 20_000;
  while (!(existsSync(cachePath) && JSON.parse(readFileSync(cachePath, "utf-8")).version === NEWER) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toMatchObject({ version: NEWER });

  const second = inTerminal(runEnv, ["--version"]);
  expect(second.status).toBe(0);
  expect(second.output).toContain(`TinyCloud CLI ${NEWER} is available.`);
  expect(readFileSync(networkLog, "utf-8").trim().split("\n")).toEqual([
    "check https://registry.npmjs.org/-/package/@tinycloud%2fcli/dist-tags",
  ]);
}), 60_000);

// A handle a command leaves open (a poll timer, a broker socket). Every path where tc exited at once must still
// exit at once.
test("help, version, usage errors and failing courier commands still exit at once with a handle open", withHome(({ home, env }) => {
  const preload = join(home, "open-handle.mjs");
  writeFileSync(preload, "setTimeout(() => {}, 60_000);\n");
  for (const [args, status] of [
    [["--version"], 0],
    [["--help"], 0],
    [["help", "kv"], 0],
    [["kv", "--help"], 0],
    [[], 1],
    [["no-such-command"], 1],
    [["courier", "no-such-command"], 2],
    [["-q", "courier", "manifest"], 2],
  ] as const) {
    const result = spawnSync("node", [CLI, ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...env, TC_NO_AUTO_UPDATE: "1", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    });
    expect({ args, status: result.status }).toEqual({ args, status });
  }
}), 300_000);
