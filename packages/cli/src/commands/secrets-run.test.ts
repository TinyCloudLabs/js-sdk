import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TC_BIN, writeDelegateProfile, type WaitHermetic } from "../test-support/secrets-wait-harness.js";

// `tc secrets run` end to end: the real `bin/tc` under Node (needs a fresh
// `bun run --cwd packages/cli build`) reads a dummy secret from the loopback
// node and starts a real child process (`process.execPath -e …`).

const ROOT = mkdtempSync(join("/var/tmp", "tc2093."));
if (!ROOT.startsWith("/var/tmp/tc2093.")) throw new Error(`unexpected test home ${ROOT}`);
process.env.HOME = ROOT;
process.env.TC_HOME = ROOT;

interface Hermetic extends WaitHermetic {
  setSecretPresent(value: boolean): void;
}
// Loaded by URL: the node-sdk fixture lives outside this package's rootDir.
const hermeticModule = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(options: { secretPayloadValue: string }): Promise<Hermetic> };

/** The one secret the loopback node serves; its dummy value. */
const SECRET = "HERMETIC_DELEGATION_CANARY";
const VALUE = "tc2093 dummy value; not a real secret";
const VALUE_SHA256 = createHash("sha256").update(VALUE).digest("hex");
/** A secret the profile holds no grant for. */
const UNGRANTED = "TC2093_UNGRANTED";
const PROFILE = "agent";
const CHILD = process.execPath;
// Real child processes and Node startup: each run takes about a second.
const TIMEOUT_MS = 60_000;

let hermetic: Hermetic;

beforeAll(async () => {
  hermetic = await hermeticModule.createHermeticEncryptedNode({ secretPayloadValue: VALUE });
  await writeDelegateProfile(ROOT, hermetic, PROFILE, { grant: await hermetic.mintDelegation() });
});

afterEach(() => {
  hermetic.setSecretPresent(true);
  hermetic.denyKvReads([]);
});

afterAll(() => {
  hermetic?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

interface Run {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** tc's environment: the test home, no host, key or profile override, no inherited secret variable. */
function tcEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: ROOT, TC_HOME: ROOT, TC_HIDE_BANNER: "1" };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  delete env.TC_PROFILE;
  delete env[SECRET];
  return Object.assign(env, extra);
}

/**
 * `node bin/tc --profile PROFILE ARGS` against the test home, in a session of
 * its own (no terminal), so signals reach tc alone. `whileRunning` gets the
 * tc PID and a wait for text on stdout; tc is killed if it is still running
 * when the run settles, so a regression fails rather than hangs.
 */
async function tc(
  args: readonly string[],
  options: {
    profile?: string;
    env?: Readonly<Record<string, string>>;
    whileRunning?: (pid: number, stdoutContains: (text: string) => Promise<void>) => Promise<void>;
  } = {},
): Promise<Run> {
  const proc = Bun.spawn([process.env.NODE_BINARY ?? "node", TC_BIN, "--profile", options.profile ?? PROFILE, ...args], {
    env: tcEnv(options.env),
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  let stdoutDone = false;
  let stdoutChanged = (): void => {};
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of proc.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
      stdoutChanged();
    }
    stdoutDone = true;
    stdoutChanged();
  })();
  const stdoutContains = async (text: string): Promise<void> => {
    while (!stdout.includes(text)) {
      if (stdoutDone) throw new Error(`tc closed stdout before printing ${JSON.stringify(text)}: ${stdout}`);
      const changed = Promise.withResolvers<void>();
      stdoutChanged = changed.resolve;
      await changed.promise;
    }
  };
  try {
    await options.whileRunning?.(proc.pid, stdoutContains);
    const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited, reading]);
    return { exitCode: proc.exitCode, signalCode: proc.signalCode, stdout, stderr };
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
}

/** `-- <bun> -e CODE -- ARGS`: the child command after tc's separator. */
function child(code: string, ...args: string[]): string[] {
  return ["--", CHILD, "-e", code, "--", ...args];
}

/** A child that records that it started, then exits 0. */
function markerChild(marker: string): string[] {
  return child(`require("node:fs").writeFileSync(process.argv[1], "started")`, marker);
}

/** The `error` of the JSON error document tc wrote to stderr. */
function errorOf(run: Run): unknown {
  const document: unknown = JSON.parse(run.stderr);
  return typeof document === "object" && document !== null && "error" in document ? document.error : undefined;
}

/** Every file under the test home that contains the secret value. */
function filesContainingValue(directory: string = ROOT): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return filesContainingValue(path);
    return readFileSync(path).includes(VALUE) ? [path] : [];
  });
}

let markers = 0;
function markerPath(): string {
  markers += 1;
  return join(ROOT, `child-started-${markers}`);
}

describe("tc secrets run", () => {
  test("the secret reaches the child's environment, over an inherited variable of the same name; tc prints nothing itself", async () => {
    const run = await tc(["secrets", "run", SECRET, ...child(
      `const { createHash } = require("node:crypto");
       const value = process.env.${SECRET};
       process.stdout.write(JSON.stringify({
         sha256: value === undefined ? null : createHash("sha256").update(value).digest("hex"),
         inherited: process.env.TC2093_INHERITED ?? null,
       }));`,
    )], { env: { [SECRET]: "inherited value", TC2093_INHERITED: "kept" } });

    expect({ exitCode: run.exitCode, signalCode: run.signalCode, stderr: run.stderr }).toEqual({ exitCode: 0, signalCode: null, stderr: "" });
    // stdout is the child's output and nothing else.
    expect(JSON.parse(run.stdout)).toEqual({ sha256: VALUE_SHA256, inherited: "kept" });
    expect(run.stdout).not.toContain(VALUE);
    expect(filesContainingValue()).toEqual([]);
  }, TIMEOUT_MS);

  const verbatim = [
    "--raw", "-o", "x", "two words", "$HOME", "a;b", "`id`", "$(id)", "*", "",
    "--scope", "s", "--profile", "p", "--map", "A=B", "--json", "--help", "-h", "--version", "-V", "--", "--private-key", "k",
  ];
  const printArgv = `process.stdout.write(JSON.stringify(process.argv.slice(1)))`;
  for (const [label, selection] of [
    ["a positional name", [SECRET]],
    ["--map before --", ["--map", `${SECRET}=TC2093_MAPPED`]],
  ] as const) {
    test(`argv after -- reaches the child verbatim and unparsed, with ${label}`, async () => {
      const run = await tc(["secrets", "run", ...selection, ...child(printArgv, ...verbatim)]);

      expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(run.stdout)).toEqual(verbatim);
    }, TIMEOUT_MS);
  }

  test("--map exports the secret under the mapped name only", async () => {
    const run = await tc(["secrets", "run", "--map", `${SECRET}=TC2093_MAPPED`, ...child(
      `const { createHash } = require("node:crypto");
       process.stdout.write(JSON.stringify({
         mapped: createHash("sha256").update(process.env.TC2093_MAPPED ?? "").digest("hex"),
         original: process.env.${SECRET} ?? null,
       }));`,
    )]);

    expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(run.stdout)).toEqual({ mapped: VALUE_SHA256, original: null });
  }, TIMEOUT_MS);

  for (const [label, args] of [
    ["no --", (marker: string) => [SECRET, CHILD, marker]],
    ["nothing after --", () => [SECRET, "--"]],
    ["no secret selected", (marker: string) => markerChild(marker)],
    ["a name that is no environment variable name, without --map", (marker: string) => ["lower-case", ...markerChild(marker)]],
    ["a --map target that is no environment variable name", (marker: string) => ["--map", `${SECRET}=1BAD`, ...markerChild(marker)]],
    ["a --map without =", (marker: string) => ["--map", SECRET, ...markerChild(marker)]],
    ["a positional name and a --map with the same target", (marker: string) => [SECRET, "--map", `${UNGRANTED}=${SECRET}`, ...markerChild(marker)]],
    ["two --map with the same target", (marker: string) => ["--map", `${SECRET}=TC2093_X`, "--map", `${UNGRANTED}=TC2093_X`, ...markerChild(marker)]],
  ] as const) {
    test(`refuses ${label} as a usage error before any fetch`, async () => {
      const marker = markerPath();
      const before = hermetic.requests().length;
      const run = await tc(["secrets", "run", ...args(marker)]);

      expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({ exitCode: 2, stdout: "" });
      expect(errorOf(run)).toMatchObject({ code: "USAGE_ERROR" });
      expect(hermetic.requests().length).toBe(before);
      expect(existsSync(marker)).toBe(false);
    }, TIMEOUT_MS);
  }

  test("the child's exit code is tc's exit code", async () => {
    const run = await tc(["secrets", "run", SECRET, ...child("process.exit(3)")]);

    expect({ exitCode: run.exitCode, signalCode: run.signalCode, stdout: run.stdout, stderr: run.stderr })
      .toEqual({ exitCode: 3, signalCode: null, stdout: "", stderr: "" });
  }, TIMEOUT_MS);

  test("a child killed by SIGTERM ends tc with SIGTERM", async () => {
    const run = await tc(["secrets", "run", SECRET, ...child(`process.kill(process.pid, "SIGTERM")`)]);

    expect({ exitCode: run.exitCode, signalCode: run.signalCode, stdout: run.stdout, stderr: run.stderr })
      .toEqual({ exitCode: null, signalCode: "SIGTERM", stdout: "", stderr: "" });
  }, TIMEOUT_MS);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    test(`${signal} sent to tc reaches the child`, async () => {
      const run = await tc(["secrets", "run", SECRET, ...child(
        `process.on(${JSON.stringify(signal)}, () => { process.stdout.write("got ${signal}\\n"); process.exit(42); });
         process.stdout.write("ready\\n");
         setTimeout(() => process.exit(9), 15000);`,
      )], {
        whileRunning: async (pid, stdoutContains) => {
          await stdoutContains("ready\n");
          process.kill(pid, signal);
        },
      });

      expect({ exitCode: run.exitCode, signalCode: run.signalCode, stdout: run.stdout, stderr: run.stderr })
        .toEqual({ exitCode: 42, signalCode: null, stdout: `ready\ngot ${signal}\n`, stderr: "" });
    }, TIMEOUT_MS);
  }

  test("a Ctrl-C at the terminal reaches the child once: tc, as the foreground job, does not pass it on again", async () => {
    const proc = Bun.spawn([
      "python3", join(import.meta.dir, "../../test-support/pty-interrupt.py"), "child-ready",
      process.env.NODE_BINARY ?? "node", TC_BIN, "--profile", PROFILE, "secrets", "run", SECRET, ...child(
        `let count = 0;
         process.on("SIGINT", () => {
           count += 1;
           // A second delivery would arrive well within this window.
           if (count === 1) setTimeout(() => { process.stdout.write("sigint count=" + count + "\\n"); process.exit(42); }, 500);
         });
         process.stdout.write("child-ready\\n");
         setTimeout(() => process.exit(9), 15000);`,
      ),
    ], { env: tcEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    const result: unknown = JSON.parse(stdout);
    expect(result).toMatchObject({ exit: 42, signal: null, output: expect.stringContaining("sigint count=1\r\n") });
  }, TIMEOUT_MS);

  for (const [label, names, failing, arrange] of [
    ["a missing secret", [SECRET], SECRET, () => hermetic.setSecretPresent(false)],
    ["a denied read", [SECRET], SECRET, () => hermetic.denyKvReads([`vault/secrets/${SECRET}`])],
    ["one failing secret after a readable one", [SECRET, UNGRANTED], UNGRANTED, () => {}],
  ] as const) {
    test(`${label}: the child never starts and tc fails as secrets get does`, async () => {
      arrange();
      const get = await tc(["secrets", "get", failing]);
      const marker = markerPath();
      const run = await tc(["secrets", "run", ...names, ...markerChild(marker)]);

      expect(get.exitCode).not.toBe(0);
      expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({ exitCode: get.exitCode, stdout: "" });
      expect(errorOf(run)).toEqual(errorOf(get));
      expect(existsSync(marker)).toBe(false);
      expect(run.stderr).not.toContain(VALUE);
    }, TIMEOUT_MS);
  }

  test("a command that does not exist exits 127 and names only the command", async () => {
    const run = await tc(["secrets", "run", SECRET, "--", "tc2093-no-such-command", "TC2093_ARG_CANARY"]);

    expect({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr })
      .toEqual({ exitCode: 127, stdout: "", stderr: "tc secrets run: tc2093-no-such-command: command not found\n" });
  }, TIMEOUT_MS);

  test("a command that is not executable exits 126 and names only the command", async () => {
    const script = join(ROOT, "not-executable");
    writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const run = await tc(["secrets", "run", SECRET, "--", script, "TC2093_ARG_CANARY"]);

    expect({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr })
      .toEqual({ exitCode: 126, stdout: "", stderr: `tc secrets run: ${script}: permission denied\n` });
  }, TIMEOUT_MS);

  test("a value an environment variable cannot hold (NUL) never starts the command and is never printed", async () => {
    const nulValue = "tc2093 nul\u0000value";
    const nul = await hermeticModule.createHermeticEncryptedNode({ secretPayloadValue: nulValue });
    try {
      await writeDelegateProfile(ROOT, nul, "nul", { grant: await nul.mintDelegation() });
      const marker = markerPath();
      const run = await tc(["secrets", "run", SECRET, ...markerChild(marker)], { profile: "nul" });

      expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({ exitCode: 1, stdout: "" });
      expect(errorOf(run)).toEqual({
        code: "SECRET_NOT_EXPORTABLE",
        message: `Secret "${SECRET}" contains a NUL character, so it can't be put in an environment variable. The command wasn't started.`,
      });
      expect(existsSync(marker)).toBe(false);
      expect(run.stderr).not.toContain("nul\\u0000value");
      expect(run.stderr).not.toContain("nul\\x00value");
    } finally {
      nul.stop();
    }
  }, TIMEOUT_MS);
});
