import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockChildEnv } from "./lock-children.js";
import { waitForProfileLockProtocol } from "./profile-lock-protocol.js";

const fixture = (name: string) => new URL(`../../test-support/${name}`, import.meta.url).pathname;
const PROFILE = "delegate";
// Well inside every helper's own wait: the shortest, a holder's wait for
// release, is 15s, and a test barrier waits forever.
const ORPHAN_EXIT_TIMEOUT_MS = 5_000;
const NOW = "2026-01-01T00:00:00.000Z";
const RECORD = JSON.stringify({ requestId: "req_orphan" });

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
  readonly fixture: string;
  args(home: string): string[];
  /** Parks the helper at the lock's publish test barrier, which polls without a timeout. */
  readonly atBarrier?: true;
  /** The signal file a helper writes once inside the wait; at a barrier, its ready file. */
  ready?(home: string): string;
}

const cases: OrphanCase[] = [
  {
    name: "hold-profile-lock.ts holding the lock",
    fixture: "hold-profile-lock.ts",
    args: (home) => [PROFILE, join(home, "holders"), join(home, "ready"), join(home, "release"), "10000", "30000"],
    ready: (home) => join(home, "ready"),
  },
  {
    name: "hold-profile-lock.ts mid-wait at a test barrier",
    fixture: "hold-profile-lock.ts",
    args: (home) => [PROFILE, join(home, "holders"), join(home, "ready"), join(home, "release"), "10000", "30000"],
    atBarrier: true,
  },
  {
    name: "hold-profile-store-writer.ts holding the lock",
    fixture: "hold-profile-store-writer.ts",
    args: (home) => [PROFILE, "auth-requests", "req_orphan", RECORD, join(home, "ready"), join(home, "release")],
    ready: (home) => join(home, "ready"),
  },
  {
    name: "cycle-profile-lock.ts mid-wait at a test barrier",
    fixture: "cycle-profile-lock.ts",
    args: (home) => [PROFILE, join(home, "holders"), "3", "30000"],
    atBarrier: true,
  },
  {
    name: "turn-fault.ts holding the lock",
    fixture: "turn-fault.ts",
    args: (home) => [PROFILE, join(home, "holders"), join(home, "signals"), "hold"],
    ready: (home) => join(home, "signals", "holding"),
  },
  {
    name: "turn-fault.ts mid-wait for a second acquisition",
    fixture: "turn-fault.ts",
    args: (home) => [PROFILE, join(home, "holders"), join(home, "signals"), "-"],
    ready: (home) => join(home, "signals", "first"),
  },
  {
    name: "append-profile-record.ts mid-wait at a test barrier",
    fixture: "append-profile-record.ts",
    args: () => [PROFILE, "req_orphan", RECORD],
    atBarrier: true,
  },
  {
    name: "create-artifact-request.ts mid-wait at a test barrier",
    fixture: "create-artifact-request.ts",
    args: () => [PROFILE, "req_orphan", NOW],
    atBarrier: true,
  },
];

// Tuples: Bun 1.2.0 (CI) does not interpolate "$name" from object cases.
test.each(cases.map((orphanCase) => [orphanCase.name, orphanCase] as const))("%s exits once its parent is SIGKILLed", async (_, orphanCase) => {
  const home = await mkdtemp(join("/var/tmp", "tinycloud-operations-orphan-"));
  homes.push(home);
  const barrier = join(home, "barrier");
  await Promise.all(["holders", "signals", "barrier"].map((name) => mkdir(join(home, name))));
  const parent = Bun.spawn(
    [process.execPath, fixture("orphaning-parent.ts"), process.execPath, fixture(orphanCase.fixture), ...orphanCase.args(home)],
    {
      env: lockChildEnv(home, orphanCase.atBarrier ? { TC_TEST_PROFILE_LOCK_PUBLISH_BARRIER_DIR: barrier } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  parents.push(parent);
  // The helper shares this pipe, so it closes only once the helper exits too.
  const stderr = new Response(parent.stderr).text();
  const pid = Number((await firstLine(parent.stdout)).trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  helpers.push(pid);

  const ready = orphanCase.ready?.(home) ?? join(barrier, `ready-${pid}-${PROFILE}`);
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
  expect(output).toContain(`Test helper ${pid} exiting: its parent process ${parent.pid} exited.`);
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
