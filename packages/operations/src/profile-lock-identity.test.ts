import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The operations runner discovers every src/*.test.ts; the fixture imports
// built ESM under Node, just like the CLI and MCP runtime.
const fixture = new URL("../test-support/lock-identity.mjs", import.meta.url).pathname;
const node = Bun.which("node");
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function exercise(mode: string): Promise<{ outcome: string; recordedFields?: Record<string, unknown> }> {
  if (!node) throw new Error("Node is required for the built operations lock fixture.");
  const home = await mkdtemp(join(tmpdir(), "tc-lock-identity-"));
  homes.push(home);
  const output = join(home, "out.json");
  const child = Bun.spawn([node, fixture, mode, "delegate", output], {
    env: { ...process.env, TC_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(await readFile(output, "utf8"));
}

for (const mode of ["restart", "restart-turn", "restart-lock"]) {
  test.skipIf(process.platform !== "linux")(`${mode}: a same-PID container incarnation reclaims its predecessor's record`, async () => {
    const { outcome, recordedFields } = await exercise(mode);
    expect(outcome).toBe("entered");
    expect(Object.values(recordedFields ?? {}).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    expect(Object.keys(recordedFields ?? {})).toHaveLength(5);
  }, 15_000);
}

test.skipIf(process.platform !== "linux")("a reused PID in the same namespace is reclaimed", async () => {
  expect((await exercise("reuse-in-namespace")).outcome).toBe("entered");
}, 15_000);

test.skipIf(process.platform !== "linux")("a live same-PID holder in another namespace is not reclaimed", async () => {
  expect((await exercise("foreign")).outcome).toBe("PROFILE_LOCK_TIMEOUT");
}, 15_000);

test.skipIf(process.platform !== "linux")("a live same-PID owner in another namespace keeps its .lock", async () => {
  expect((await exercise("foreign-lock")).outcome).toBe("PROFILE_LOCK_TIMEOUT");
}, 15_000);

test.skipIf(process.platform !== "linux")("a different boot ID is not treated as proof of death", async () => {
  expect((await exercise("wrong-boot")).outcome).toBe("PROFILE_LOCK_TIMEOUT");
}, 15_000);

for (const mode of ["legacy-turn", "legacy-lock"]) {
  test(`${mode}: records without identity fields keep the PID-only decision`, async () => {
    expect((await exercise(mode)).outcome).toBe("PROFILE_LOCK_TIMEOUT");
  }, 15_000);
}
