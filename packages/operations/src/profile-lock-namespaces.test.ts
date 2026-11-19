import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_LOCK_HELPER_ENV, waitForProfileLockProtocol } from "./test-support/profile-lock-protocol.js";

// Exercise separate PID namespaces with the built Node runtime. CI enables
// unprivileged user namespaces and must run these scenarios; elsewhere they
// skip when unavailable. Contention uses the lock's real deadline, not
// test-side sleeps.
const node = Bun.which("node");
// refuse-connect.py knows the connect syscall number on these architectures only.
const python = ["x64", "arm64"].includes(process.arch) ? Bun.which("python3") : null;
const fixture = new URL("../test-support/lock-namespace.mjs", import.meta.url).pathname;
const refuseConnect = new URL("../test-support/refuse-connect.py", import.meta.url).pathname;
const CONTAINER = ["unshare", "--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--uts", "--net", "--kill-child=SIGKILL"];
// The same command the CI workflow runs before the operations tests.
const PREFLIGHT = [...CONTAINER, "sh", "-c", "hostname abcdef012345 && echo 10 > /proc/sys/kernel/ns_last_pid"];
function namespacesWork(): boolean {
  if (process.platform !== "linux" || node === null) return false;
  try {
    return Bun.spawnSync(PREFLIGHT).exitCode === 0;
  } catch {
    return false; // no unshare binary
  }
}
const namespaces = namespacesWork();
if (process.env.CI && (!namespaces || python === null || Bun.which("nsenter") === null)) {
  throw new Error(`CI must run the PID-namespace profile-lock tests: \`${PREFLIGHT.join(" ")}\`, python3 and nsenter are required.`);
}
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function container(hostname: string, ...args: string[]): string[] {
  return [...CONTAINER, "sh", "-c", 'hostname "$0" && exec "$@"', hostname, node!, fixture, ...args];
}

/** Host PID of the deepest descendant: the fixture, PID 1 in its namespace. */
function leaf(pid: number): number {
  for (;;) {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    if (children.length === 0) return pid;
    pid = Number(children[0]);
  }
}

async function home(long: boolean): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "tc-lock-ns-"));
  homes.push(base);
  const path = long ? join(base, "tenants", "t".repeat(48)) : base;
  await mkdir(path, { recursive: true });
  return path;
}

/** A PID-1 holder inside its critical section; ending its stdin releases it. */
async function hold(tcHome: string) {
  const holder = Bun.spawn(container("abcdef012345", "hold"), {
    env: { ...process.env, ...PROFILE_LOCK_HELPER_ENV, TC_HOME: tcHome }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = holder.stdout.getReader();
  let seen = "";
  while (!seen.includes("ready\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder exited: ${await new Response(holder.stderr).text()}`);
    seen += new TextDecoder().decode(value);
  }
  return { holder, fixturePid: leaf(holder.pid), release: async () => { holder.stdin.end(); await holder.exited; } };
}

async function contend(tcHome: string, hostname: string, timeoutMs = 2000, wrapper: string[] = []) {
  const out = join(tcHome, "contender.json");
  const command = [...CONTAINER, "sh", "-c", 'hostname "$0" && exec "$@"', hostname, ...wrapper, node!, fixture, "contend", out, String(timeoutMs)];
  const child = Bun.spawn(command, { env: { ...process.env, ...PROFILE_LOCK_HELPER_ENV, TC_HOME: tcHome }, stderr: "pipe" });
  const exit = await child.exited;
  if (exit !== 0) throw new Error(await new Response(child.stderr).text());
  return JSON.parse(await readFile(out, "utf8"));
}

test.skipIf(!namespaces || python === null)("a PID 1 whose seccomp filter fails every connect waits for a live PID 1", async () => {
  const tcHome = await home(false);
  const { release } = await hold(tcHome);
  try {
    expect(await contend(tcHome, "abcdef012345", 2000, [python!, refuseConnect])).toMatchObject({ pid: 1, outcome: "PROFILE_LOCK_TIMEOUT" });
  } finally {
    await release();
  }
}, 20_000);

test.skipIf(!namespaces)("a PID 1 sharing only profiles/ with a live PID 1 waits for it", async () => {
  const tcHome = await home(false);
  const { release } = await hold(tcHome);
  try {
    const other = await home(false);
    await mkdir(join(other, ".tinycloud"));
    await symlink(join(tcHome, ".tinycloud", "profiles"), join(other, ".tinycloud", "profiles"));
    expect(await contend(other, "abcdef012345")).toMatchObject({ pid: 1, outcome: "PROFILE_LOCK_TIMEOUT" });
  } finally {
    await release();
  }
}, 20_000);

test.skipIf(!namespaces)("a PID 1 finding the turn directory recreated waits for a live PID 1", async () => {
  const tcHome = await home(false);
  const { release } = await hold(tcHome);
  try {
    const turns = join(tcHome, ".tinycloud", "profile-locks", "probe");
    await rename(turns, `${turns}.moved`);
    expect(await contend(tcHome, "abcdef012345")).toMatchObject({ pid: 1, outcome: "PROFILE_LOCK_TIMEOUT" });
  } finally {
    await release();
  }
}, 20_000);

for (const long of [false, true]) {
  test.skipIf(!namespaces)(`a restarted PID 1 reclaims its crashed predecessor's turn and .lock${long ? " (socket path over 108 bytes)" : ""}`, async () => {
    const tcHome = await home(long);
    const { holder, fixturePid } = await hold(tcHome);
    process.kill(fixturePid, "SIGKILL");
    await holder.exited;
    await rm(join(tcHome, "inside"), { force: true });
    const result = await contend(tcHome, long ? "mcp-7d9f8c6b5-x2k4p" : "abcdef012345");
    expect(result).toMatchObject({ pid: 1, outcome: "entered", leftovers: [] });
  }, 20_000);
}

test.skipIf(!namespaces)("a live PID 1 in another PID namespace keeps the lock", async () => {
  const tcHome = await home(false);
  const { release } = await hold(tcHome);
  try {
    expect(await contend(tcHome, "abcdef012345")).toMatchObject({ pid: 1, outcome: "PROFILE_LOCK_TIMEOUT" });
  } finally {
    await release();
  }
}, 20_000);

test.skipIf(!namespaces)("a paused PID 1 in another PID namespace keeps the lock past a full backlog", async () => {
  const tcHome = await home(false);
  const { fixturePid, release } = await hold(tcHome);
  process.kill(fixturePid, "SIGSTOP");
  try {
    expect(await contend(tcHome, "abcdef012345", 3000)).toMatchObject({ pid: 1, outcome: "PROFILE_LOCK_TIMEOUT" });
  } finally {
    process.kill(fixturePid, "SIGCONT");
    await release();
  }
}, 20_000);

test.skipIf(!namespaces)("a live PID 1 sharing the holder's UTS namespace keeps the lock", async () => {
  const tcHome = await home(false);
  const { fixturePid, release } = await hold(tcHome);
  try {
    const out = join(tcHome, "shared-uts.json");
    const child = Bun.spawn([
      "nsenter", "-t", String(fixturePid), "--user", "--uts", "--preserve-credentials",
      "unshare", "--pid", "--fork", "--mount-proc", "--net", "--kill-child=SIGKILL",
      "sh", "-c", 'exec "$@"', "sh", node!, fixture, "contend", out, "2000",
    ], { env: { ...process.env, ...PROFILE_LOCK_HELPER_ENV, TC_HOME: tcHome }, stderr: "pipe" });
    const exit = await child.exited;
    if (exit !== 0) throw new Error(await new Response(child.stderr).text());
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({
      pid: 1, outcome: "PROFILE_LOCK_TIMEOUT", overlap: false,
    });
  } finally {
    await release();
  }
}, 20_000);

test.skipIf(!namespaces)("a reused PID in the same namespace reclaims its predecessor", async () => {
  const tcHome = await home(false);
  const out = join(tcHome, "reused-pid.json");
  // The shell stays PID 1. Once its child exits, resetting ns_last_pid makes
  // the next (non-exec) Node child reuse the holder's PID in that namespace.
  const script = [
    "hostname abcdef012345 || exit 1",
    // Background jobs otherwise inherit /dev/null and release the holder immediately.
    "exec 3<&0",
    '"$1" "$2" hold <&3 & holder=$!',
    'wait "$holder" || :',
    'rm -f "$TC_HOME/inside"',
    'echo "$((holder-1))" > /proc/sys/kernel/ns_last_pid',
    '"$1" "$2" contend "$3" 2000',
  ].join("\n");
  const shell = Bun.spawn([...CONTAINER, "sh", "-c", script, "sh", node!, fixture, out], {
    env: { ...process.env, ...PROFILE_LOCK_HELPER_ENV, TC_HOME: tcHome }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = shell.stdout.getReader();
  let seen = "";
  while (!seen.includes("ready\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder exited before ready: ${await new Response(shell.stderr).text()}`);
    seen += new TextDecoder().decode(value);
  }
  const holderNamespacePid = Number(await readFile(join(tcHome, "inside"), "utf8"));
  process.kill(leaf(shell.pid), "SIGKILL");
  const exit = await shell.exited;
  if (exit !== 0) throw new Error(await new Response(shell.stderr).text());
  expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({
    pid: holderNamespacePid, outcome: "entered", overlap: false, leftovers: [],
  });
}, 20_000);

test.skipIf(!namespaces)("a PID-1 crash during turn publication cleans its stage and socket", async () => {
  const tcHome = await home(false);
  const barrier = join(tcHome, "publish-barrier");
  await mkdir(barrier);
  const holder = Bun.spawn(container("abcdef012345", "hold"), {
    env: {
      ...process.env,
      ...PROFILE_LOCK_HELPER_ENV,
      TC_HOME: tcHome,
      NODE_ENV: "test",
      TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR: barrier,
    },
    stdin: "pipe", stderr: "pipe",
  });
  await waitForProfileLockProtocol(join(barrier, "ready-1-probe"), "PID-1 turn publication");
  process.kill(leaf(holder.pid), "SIGKILL");
  await holder.exited;
  expect(await contend(tcHome, "abcdef012345")).toMatchObject({
    pid: 1, outcome: "entered", overlap: false, leftovers: [],
  });
}, 20_000);
