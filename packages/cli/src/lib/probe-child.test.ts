import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCommandArgs, runProbeChild, type ProbeOutcome, type ProbeRequest } from "./probe-child.js";

// Real child processes running fixture scripts (`<runtime> -e SCRIPT`).

const dir = await mkdtemp(join(tmpdir(), "tc-probe-child-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const request: ProbeRequest = { profile: "agent", host: "http://127.0.0.1:1", names: ["A", "B"], scope: "food-drinks" };
const envelope = JSON.stringify({
  status: "ok",
  operation: { operationId: "tinycloud.secrets.status", operationVersion: 1 },
  context: {},
  output: { status: "ready", owner: "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf", names: ["A"], present: ["A"], pending: [], denied: [] },
});
const HANG = "setInterval(() => {}, 1000);";

/** Records SIGTERM in `marker`; exits on it unless `ignore`. */
function onTerm(marker: string, ignore: boolean): string {
  return `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "term"); ${ignore ? "" : "process.exit(0);"} });`;
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function run(script: string, budgetMs = 5_000): Promise<{ outcome: ProbeOutcome; pid: number; elapsed: number }> {
  let pid = 0;
  const started = performance.now();
  const outcome = await runProbeChild(request, {
    argv: ["-e", script],
    budgetMs,
    onSpawn: (spawned) => {
      pid = spawned;
    },
  });
  const elapsed = performance.now() - started;
  expect(pid).toBeGreaterThan(0);
  // The child is always gone (reaped) when runProbeChild resolves.
  expect(gone(pid)).toBe(true);
  return { outcome, pid, elapsed };
}

describe("runProbeChild", () => {
  test("(a) prints the line and exits → ok", async () => {
    const { outcome } = await run(`process.stdout.write(${JSON.stringify(envelope + "\n")});`);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.envelope.status).toBe("ok");
  });

  test("(b) prints the line, then hangs → ok, and the child gets SIGTERM", async () => {
    const marker = join(dir, "b-term");
    const { outcome, elapsed } = await run(`${onTerm(marker, false)} process.stdout.write(${JSON.stringify(envelope + "\n")}); ${HANG}`);
    expect(outcome.kind).toBe("ok");
    expect(existsSync(marker)).toBe(true);
    expect(elapsed).toBeLessThan(4_000);
  });

  test("(b') the line, then SIGTERM is ignored → SIGKILL after 500 ms", async () => {
    const marker = join(dir, "b2-term");
    const { outcome, elapsed } = await run(`${onTerm(marker, true)} process.stdout.write(${JSON.stringify(envelope + "\n")}); ${HANG}`);
    expect(outcome.kind).toBe("ok");
    expect(existsSync(marker)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(4_000);
  });

  test("(c) hangs silently → timeout at the budget, then SIGTERM → SIGKILL", async () => {
    const marker = join(dir, "c-term");
    const { outcome, elapsed } = await run(`${onTerm(marker, true)} ${HANG}`, 300);
    expect(outcome).toEqual({ kind: "timeout" });
    expect(existsSync(marker)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(4_000);
  });

  test("(d) exits without output → probe_failed, with the child's stderr error.code", async () => {
    expect((await run("process.exit(3);")).outcome).toEqual({ kind: "probe_failed" });
    const stderr = JSON.stringify({ error: { code: "PROFILE_NOT_FOUND", message: "no profile" } }, null, 2);
    expect((await run(`process.stderr.write("noise\\n" + ${JSON.stringify(stderr)} + "\\n"); process.exit(4);`)).outcome)
      .toEqual({ kind: "probe_failed", childErrorCode: "PROFILE_NOT_FOUND" });
  });

  test("(e) garbage, a non-status envelope, or an oversized line → probe_failed", async () => {
    expect((await run(`process.stdout.write("not json\\n"); ${HANG}`)).outcome).toEqual({ kind: "probe_failed" });
    const other = JSON.stringify({ status: "ok", operation: { operationId: "tinycloud.secrets.get" }, output: {} });
    expect((await run(`process.stdout.write(${JSON.stringify(other + "\n")});`)).outcome).toEqual({ kind: "probe_failed" });
    const authority = JSON.stringify({ status: "authority_required", operation: { operationId: "tinycloud.secrets.status" } });
    expect((await run(`process.stdout.write(${JSON.stringify(authority + "\n")});`)).outcome).toEqual({ kind: "probe_failed" });
    expect((await run(`process.stdout.write("x".repeat(70 * 1024)); ${HANG}`)).outcome).toEqual({ kind: "probe_failed" });
  });

  test("an aborted signal stops the child → cancelled", async () => {
    const controller = new AbortController();
    let pid = 0;
    const outcome = await runProbeChild(request, {
      argv: ["-e", HANG],
      signal: controller.signal,
      onSpawn: (spawned) => {
        pid = spawned;
        // The child is running; abort it mid-attempt.
        controller.abort();
      },
    });
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(gone(pid)).toBe(true);
  });

  test("(f) the spawn arguments never contain TC_PRIVATE_KEY's value; the key reaches the child only via env", async () => {
    const key = "ab".repeat(32);
    const original = process.env.TC_PRIVATE_KEY;
    process.env.TC_PRIVATE_KEY = key;
    const captured: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    let pid = 0;
    try {
      const outcome = await runProbeChild({ ...request, owner: "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" }, {
        spawn: (command, args, options) => {
          captured.push({ command, args, options });
          // Run a harmless child in place of tc, with the same options.
          return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(envelope + "\n")});`], options);
        },
        onSpawn: (spawned) => {
          pid = spawned;
        },
      });
      expect(outcome.kind).toBe("ok");
    } finally {
      if (original === undefined) delete process.env.TC_PRIVATE_KEY;
      else process.env.TC_PRIVATE_KEY = original;
    }
    expect(gone(pid)).toBe(true);
    expect(captured).toHaveLength(1);
    const [{ command, args, options }] = captured as [typeof captured[number]];
    expect(command).toBe(process.execPath);
    expect([command, ...args].join(" ")).not.toContain(key);
    // Production argv: runtime flags, this entry point, then the probe arguments only.
    expect(args.slice(-probeCommandArgs({ ...request, owner: "x" }).length)).toEqual([
      "--json", "--profile", "agent", "--host", "http://127.0.0.1:1",
      "secrets", "probe", "A", "B", "--scope", "food-drinks",
      "--owner", "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    ]);
    expect(options.env).toBe(process.env);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});
