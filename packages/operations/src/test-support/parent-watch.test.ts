import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockChildEnv } from "./lock-children.js";
import { waitForProfileLockProtocol } from "./profile-lock-protocol.js";

const fixture = (name: string) => new URL(`../../test-support/${name}`, import.meta.url).pathname;
const bun = process.execPath;
const node = Bun.which("node");
if (!node) throw new Error("These tests need Node on PATH, as the CLI does.");
const PROFILE = "delegate";
// Well inside every helper's own wait: the shortest, a holder's wait for
// release, is 15s, and a test barrier waits forever.
const ORPHAN_EXIT_TIMEOUT_MS = 5_000;
const NOW = "2026-01-01T00:00:00.000Z";
const RECORD = JSON.stringify({ requestId: "req_orphan" });
// As profile-lock-namespaces.test.ts runs lock-namespace.mjs: PID 1 of a new PID namespace.
const CONTAINER = ["unshare", "--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--uts", "--net", "--kill-child=SIGKILL"];
const namespaces = (() => {
  try {
    return process.platform === "linux" && Bun.spawnSync([...CONTAINER, "true"]).exitCode === 0;
  } catch {
    return false; // no unshare binary
  }
})();

const homes: string[] = [];
const parents: Bun.Subprocess[] = [];
const helpers: number[] = [];

afterEach(async () => {
  for (const parent of parents.splice(0)) parent.kill("SIGKILL");
  for (const pid of helpers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, as it should be.
    }
  }
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

interface OrphanCase {
  readonly name: string;
  /** The helper's command line, which the intermediate parent starts. */
  command(home: string): string[];
  /** Parks the helper at the lock's publish test barrier, which polls without a timeout. */
  readonly atBarrier?: true;
  /** The file showing the helper is inside its wait; by default its publish-barrier ready file. */
  ready?(home: string, pid: number): string;
  /** What the helper says as it exits; by default, that its parent exited. */
  exitMessage?(pid: number, parentPid: number): string;
}

const holdProfileLock = (home: string) =>
  [bun, fixture("hold-profile-lock.ts"), PROFILE, join(home, "holders"), join(home, "ready"), join(home, "release"), "10000", "30000"];

const cases: OrphanCase[] = [
  {
    name: "hold-profile-lock.ts holding the lock",
    command: holdProfileLock,
    ready: (home) => join(home, "ready"),
  },
  {
    name: "hold-profile-lock.ts mid-wait at a test barrier",
    command: holdProfileLock,
    atBarrier: true,
  },
  {
    name: "hold-profile-store-writer.ts holding the lock",
    command: (home) => [bun, fixture("hold-profile-store-writer.ts"), PROFILE, "auth-requests", "req_orphan", RECORD, join(home, "ready"), join(home, "release")],
    ready: (home) => join(home, "ready"),
  },
  {
    name: "cycle-profile-lock.ts mid-wait at a test barrier",
    command: (home) => [bun, fixture("cycle-profile-lock.ts"), PROFILE, join(home, "holders"), "3", "30000"],
    atBarrier: true,
  },
  {
    name: "turn-fault.ts holding the lock",
    command: (home) => [bun, fixture("turn-fault.ts"), PROFILE, join(home, "holders"), join(home, "signals"), "hold"],
    ready: (home) => join(home, "signals", "holding"),
  },
  {
    name: "turn-fault.ts mid-wait for a second acquisition",
    command: (home) => [bun, fixture("turn-fault.ts"), PROFILE, join(home, "holders"), join(home, "signals"), "-"],
    ready: (home) => join(home, "signals", "first"),
  },
  {
    name: "append-profile-record.ts mid-wait at a test barrier",
    command: () => [bun, fixture("append-profile-record.ts"), PROFILE, "req_orphan", RECORD],
    atBarrier: true,
  },
  {
    name: "create-artifact-request.ts mid-wait at a test barrier",
    command: () => [bun, fixture("create-artifact-request.ts"), PROFILE, "req_orphan", NOW],
    atBarrier: true,
  },
  {
    name: "lock-namespace.mjs (Node) mid-wait at a test barrier",
    command: () => [node, fixture("lock-namespace.mjs"), "hold"],
    atBarrier: true,
    ready: (home, pid) => join(home, "barrier", `ready-${pid}-probe`),
  },
  {
    name: "no-hard-links/cycle-profile-lock.mjs (Node) mid-wait at a test barrier",
    command: (home) => [
      node, "-r", fixture("no-hard-links/no-hard-links.cjs"), fixture("no-hard-links/cycle-profile-lock.mjs"),
      PROFILE, join(home, "holders"), "3", "30000", "20000",
    ],
    atBarrier: true,
  },
  ...(namespaces ? [{
    // Its parent is outside its PID namespace (ppid 0), so it watches stdin.
    name: "lock-namespace.mjs (Node) as PID 1 of a PID namespace, mid-wait at a test barrier",
    command: () => [...CONTAINER, "sh", "-c", 'exec "$@"', "sh", node, fixture("lock-namespace.mjs"), "hold"],
    atBarrier: true,
    ready: (home: string) => join(home, "barrier", "ready-1-probe"),
    exitMessage: () => "Test helper 1 exiting: its stdin closed before it held the lock.",
  } satisfies OrphanCase] : []),
];

// Tuples: Bun 1.2.0 (CI) does not interpolate "$name" from object cases.
test.each(cases.map((orphanCase) => [orphanCase.name, orphanCase] as const))("%s exits once its parent is SIGKILLed", async (_, orphanCase) => {
  const home = await mkdtemp(join("/var/tmp", "tinycloud-operations-orphan-"));
  homes.push(home);
  const barrier = join(home, "barrier");
  await Promise.all(["holders", "signals", "barrier"].map((name) => mkdir(join(home, name))));
  const parent = Bun.spawn([bun, fixture("orphaning-parent.ts"), ...orphanCase.command(home)], {
    env: lockChildEnv(home, orphanCase.atBarrier ? { TC_TEST_PROFILE_LOCK_PUBLISH_BARRIER_DIR: barrier } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  parents.push(parent);
  // The helper shares this pipe, so it closes only once the helper exits too.
  const stderr = new Response(parent.stderr).text();
  const pid = Number((await firstLine(parent.stdout)).trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  helpers.push(pid);

  const ready = orphanCase.ready?.(home, pid) ?? join(barrier, `ready-${pid}-${PROFILE}`);
  await waitForProfileLockProtocol(ready, `${orphanCase.name} to start waiting`);
  parent.kill("SIGKILL");
  await parent.exited;

  // A wall-clock bound: the helper is another process, on the real clock.
  const outlived = Promise.withResolvers<never>();
  const bound = setTimeout(
    () => outlived.reject(new Error(`${orphanCase.name} (pid ${pid}) outlived its parent by ${ORPHAN_EXIT_TIMEOUT_MS}ms.`)),
    ORPHAN_EXIT_TIMEOUT_MS,
  );
  const output = await Promise.race([stderr, outlived.promise]).finally(() => clearTimeout(bound));
  expect(output).toContain(
    orphanCase.exitMessage?.(pid, parent.pid) ?? `Test helper ${pid} exiting: its parent process ${parent.pid} exited.`,
  );
}, 20_000);

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text.split("\n")[0]!;
}
