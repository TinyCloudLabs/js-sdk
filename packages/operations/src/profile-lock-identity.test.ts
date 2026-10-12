import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileLockMetadataPath, profileTurnLockPath, withProfileLock } from "./state";
import { waitForProfileLockProtocol } from "./test-support/profile-lock-protocol.js";

const fixture = new URL("../test-support/lock-identity.mjs", import.meta.url).pathname;
const holderFixture = new URL("../test-support/lock-namespace.mjs", import.meta.url).pathname;
const refuseConnect = new URL("../test-support/refuse-connect.py", import.meta.url).pathname;
const node = Bun.which("node");
// refuse-connect.py knows the connect syscall number on these architectures only.
const python = ["x64", "arm64"].includes(process.arch) ? Bun.which("python3") : null;
const linux = process.platform === "linux";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.push(home);
  return home;
}

async function exercise(mode: string, wrapper: string[] = []): Promise<{ outcome: string; socketGone?: boolean; deadRemoved?: boolean; liveKept?: boolean; invalidKept?: boolean }> {
  if (!node) throw new Error("Node is required for the built operations lock fixture.");
  const home = await tempHome("tc-lock-identity-");
  const output = join(home, "out.json");
  const child = Bun.spawn([...wrapper, node, fixture, mode, "delegate", output], {
    env: { ...process.env, TC_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(await readFile(output, "utf8"));
}

/** Liveness sockets left in the profile's turn directory. */
async function liveSockets(home: string, profile: string): Promise<string[]> {
  return (await readdir(join(home, ".tinycloud", "profile-locks", profile))).filter((name) => name.startsWith(".live-"));
}

/** The built lock under Node, outside any namespace: one contender's outcome and leftovers. */
async function contendWithNode(home: string): Promise<{ outcome: string; leftovers: string[] }> {
  const out = join(home, "contender.json");
  const child = Bun.spawn([node!, holderFixture, "contend", out, "2000"], { env: { ...process.env, TC_HOME: home }, stderr: "pipe" });
  const exit = await child.exited;
  if (exit !== 0) throw new Error(await new Response(child.stderr).text());
  return JSON.parse(await readFile(out, "utf8"));
}

for (const mode of ["restart-refused", "restart-refused-turn", "restart-refused-lock"]) {
  test.skipIf(!linux)(`${mode}: reclaims the dead socket and owner`, async () => {
    const result = await exercise(mode);
    expect(result.outcome).toBe("entered");
    expect(result.socketGone).toBe(true);
  }, 15_000);
}

test.skipIf(!linux)("removed socket permits recovery", async () => {
  expect((await exercise("restart-gone")).outcome).toBe("entered");
}, 15_000);

test.skipIf(!linux)("dead stage and its socket are collected, live and invalid stages remain", async () => {
  const result = await exercise("stage");
  expect(result.outcome).toBe("entered");
  expect(result.deadRemoved).toBe(true);
  expect(result.liveKept).toBe(true);
  expect(result.invalidKept).toBe(true);
}, 15_000);

for (const mode of ["foreign-live", "foreign-live-lock", "foreign-paused", "foreign-other-inode", "foreign-not-socket", "foreign-no-liveness", "foreign-other-directory", "wrong-boot", "same-start"]) {
  test.skipIf(!linux)(`${mode}: retains a same-PID record without proof of death`, async () => {
    expect((await exercise(mode)).outcome).toBe("PROFILE_LOCK_TIMEOUT");
  }, 15_000);
}

test.skipIf(!linux || !python)("a refusal from the contender's own seccomp filter is not proof of death", async () => {
  // Every connect fails with ECONNREFUSED without reaching the kernel, the
  // control connect to the contender's own socket included.
  const result = await exercise("restart-refused", [python!, refuseConnect]);
  expect(result.outcome).toBe("PROFILE_LOCK_TIMEOUT");
  expect(result.socketGone).toBe(false);
}, 15_000);

test.skipIf(!linux)("different start time in the same namespace proves PID reuse", async () => {
  expect((await exercise("reuse-in-namespace")).outcome).toBe("entered");
}, 15_000);

for (const mode of ["legacy-turn", "legacy-lock"]) {
  test(`${mode}: records without identity fields keep the PID-only decision`, async () => {
    expect((await exercise(mode)).outcome).toBe("PROFILE_LOCK_TIMEOUT");
  }, 15_000);
}

test.skipIf(!linux)("unreferenced sockets the kernel refuses are swept; a live one stays", async () => {
  const result = await exercise("orphans");
  expect(result).toMatchObject({ outcome: "entered", deadRemoved: true, liveKept: true });
}, 15_000);

test.skipIf(!linux)("a crash after binding, before any record, leaves no socket after the next acquisition", async () => {
  const home = await tempHome("tc-lock-orphan-");
  const barrier = join(home, "liveness-barrier");
  await mkdir(barrier);
  const holder = Bun.spawn([node!, holderFixture, "hold"], {
    env: { ...process.env, TC_HOME: home, NODE_ENV: "test", TC_TEST_PROFILE_LOCK_LIVENESS_BARRIER_DIR: barrier },
    stdin: "pipe", stderr: "pipe",
  });
  await waitForProfileLockProtocol(join(barrier, `ready-${holder.pid}-probe`), "a holder that has bound its socket");
  holder.kill("SIGKILL");
  await holder.exited;
  expect(await liveSockets(home, "probe")).toHaveLength(1);
  const result = await contendWithNode(home);
  expect(result.outcome).toBe("entered");
  expect(await liveSockets(home, "probe")).toEqual([]);
}, 20_000);

test.skipIf(!linux)("a crashed holder's socket that a Bun collector cannot judge is swept by the next Node acquisition", async () => {
  const home = await tempHome("tc-lock-bun-collector-");
  const holder = Bun.spawn([node!, holderFixture, "hold"], { env: { ...process.env, TC_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = holder.stdout.getReader();
  for (let seen = ""; !seen.includes("ready\n");) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder exited: ${await new Response(holder.stderr).text()}`);
    seen += new TextDecoder().decode(value);
  }
  holder.kill("SIGKILL");
  await holder.exited;
  await rm(join(home, "inside"), { force: true });
  const previous = process.env.TC_HOME;
  process.env.TC_HOME = home;
  try {
    // This (Bun) process settles and removes the dead holder's turn, but cannot judge its socket.
    expect(await withProfileLock("probe", async () => "entered", { timeoutMs: 2000, retryMs: 5, staleAfterMs: 1 })).toBe("entered");
  } finally {
    if (previous === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previous;
  }
  expect(await liveSockets(home, "probe")).toHaveLength(1);
  expect((await contendWithNode(home)).outcome).toBe("entered");
  expect(await liveSockets(home, "probe")).toEqual([]);
}, 20_000);

for (const removed of [false, true]) {
  test.skipIf(!linux)(`Bun ${removed ? "recovers a removed" : "waits for a refused"} same-PID socket`, async () => {
    const home = await tempHome("tc-lock-bun-");
    const previous = process.env.TC_HOME;
    process.env.TC_HOME = home;
    try {
      let owner: Record<string, any> | undefined;
      await withProfileLock("delegate", async () => { owner = JSON.parse(await readFile(profileLockMetadataPath("delegate"), "utf8")); });
      const dir = profileTurnLockPath("delegate");
      const slot = Math.max(...(await readdir(dir)).filter((name) => /^\d+$/.test(name)).map(Number));
      const path = join(dir, String(slot), "owner.json");
      const turn = JSON.parse(await readFile(path, "utf8"));
      const { dev, ino } = await stat(dir, { bigint: true });
      const socket = `.live-${dev.toString(16)}-${ino.toString(16)}-${crypto.randomUUID()}`;
      // A refused socket must be a real socket, not a regular file.
      if (!removed) {
        const child = spawn(node!, ["-e", `require('node:net').createServer().listen(${JSON.stringify(socket)}, () => console.log('ready'))`], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
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
