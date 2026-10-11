import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileLockMetadataPath, profileTurnLockPath, withProfileLock } from "./state";

const fixture = new URL("../test-support/lock-identity.mjs", import.meta.url).pathname;
const node = Bun.which("node");
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function exercise(mode: string): Promise<{ outcome: string; socketGone?: boolean; deadRemoved?: boolean; liveKept?: boolean; invalidKept?: boolean }> {
  if (!node) throw new Error("Node is required for the built operations lock fixture.");
  const home = await mkdtemp(join(tmpdir(), "tc-lock-identity-"));
  homes.push(home);
  const output = join(home, "out.json");
  const child = Bun.spawn([node, fixture, mode, "delegate", output], {
    env: { ...process.env, TC_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(await readFile(output, "utf8"));
}

for (const mode of ["restart-refused", "restart-refused-turn", "restart-refused-lock"]) {
  test.skipIf(process.platform !== "linux")(`${mode}: reclaims the dead socket and owner`, async () => {
    const result = await exercise(mode);
    expect(result.outcome).toBe("entered");
    expect(result.socketGone).toBe(true);
  }, 15_000);
}

test.skipIf(process.platform !== "linux")("removed socket permits recovery", async () => {
  expect((await exercise("restart-gone")).outcome).toBe("entered");
}, 15_000);

test.skipIf(process.platform !== "linux")("dead stage and its socket are collected, live and invalid stages remain", async () => {
  const result = await exercise("stage");
  expect(result.outcome).toBe("entered");
  expect(result.deadRemoved).toBe(true);
  expect(result.liveKept).toBe(true);
  expect(result.invalidKept).toBe(true);
}, 15_000);

for (const mode of ["foreign-live", "foreign-live-lock", "foreign-paused", "foreign-other-inode", "foreign-not-socket", "foreign-no-liveness", "wrong-boot", "same-start"]) {
  test.skipIf(process.platform !== "linux")(`${mode}: retains a same-PID record without proof of death`, async () => {
    expect((await exercise(mode)).outcome).toBe("PROFILE_LOCK_TIMEOUT");
  }, 15_000);
}

test.skipIf(process.platform !== "linux")("different start time in the same namespace proves PID reuse", async () => {
  expect((await exercise("reuse-in-namespace")).outcome).toBe("entered");
}, 15_000);

for (const mode of ["legacy-turn", "legacy-lock"]) {
  test(`${mode}: records without identity fields keep the PID-only decision`, async () => {
    expect((await exercise(mode)).outcome).toBe("PROFILE_LOCK_TIMEOUT");
  }, 15_000);
}

for (const removed of [false, true]) {
  test.skipIf(process.platform !== "linux")(`Bun ${removed ? "recovers a removed" : "waits for a refused"} same-PID socket`, async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-lock-bun-"));
    homes.push(home);
    const previous = process.env.TC_HOME;
    process.env.TC_HOME = home;
    try {
      let owner: Record<string, any> | undefined;
      await withProfileLock("delegate", async () => { owner = JSON.parse(await readFile(profileLockMetadataPath("delegate"), "utf8")); });
      const dir = profileTurnLockPath("delegate");
      const slot = Math.max(...(await readdir(dir)).filter((name) => /^\d+$/.test(name)).map(Number));
      const path = join(dir, String(slot), "owner.json");
      const turn = JSON.parse(await readFile(path, "utf8"));
      const socket = `.live-${crypto.randomUUID()}`;
      // A refused socket must be a real socket, not a regular file.
      if (!removed) {
        const child = spawn(node!, ["-e", `require('node:net').createServer().listen(${JSON.stringify(join(dir, socket))}, () => console.log('ready'))`], { stdio: ["ignore", "pipe", "pipe"] });
        await once(child.stdout!, "data");
        const stats = await lstat(join(dir, socket), { bigint: true });
        child.kill("SIGKILL");
        await once(child, "exit");
        owner!.liveness = { socket, dev: String(stats.dev), ino: String(stats.ino) };
      } else owner!.liveness = { socket, dev: "1", ino: "1" };
      const foreign = { ...turn, instanceId: "00000000-0000-4000-8000-000000000001", pidNamespace: `pid:[${BigInt(turn.pidNamespace.match(/\d+/)[0]) + 1n}]`, liveness: owner!.liveness, createdAt: new Date(Date.now() - 60_000).toISOString() };
      await writeFile(path, JSON.stringify(foreign));
      await rm(join(dir, String(slot), `${turn.token}.done`));
      const outcome = await withProfileLock("delegate", async () => "entered", { timeoutMs: 350, retryMs: 5, staleAfterMs: 1 }).catch((error) => error.code);
      expect(outcome).toBe(removed ? "entered" : "PROFILE_LOCK_TIMEOUT");
    } finally {
      if (previous === undefined) delete process.env.TC_HOME;
      else process.env.TC_HOME = previous;
    }
  }, 15_000);
}
