// Child processes that take a profile lock, for interleaving and stress tests.
// Each child runs the lock of the release TC_TEST_LOCK_PROTOCOL names
// (test-support/lock-protocol.ts): this source tree by default, "tc540" or
// "pre-tc540" for a realistic older writer.
import { readdir, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { profileLockPath } from "../state.js";

const holdFixture = new URL("../../test-support/hold-profile-lock.ts", import.meta.url).pathname;
const cycleFixture = new URL("../../test-support/cycle-profile-lock.ts", import.meta.url).pathname;
export const appendFixture = new URL("../../test-support/append-profile-record.ts", import.meta.url).pathname;

const LOCK_TEST_ENVIRONMENT = [
  ...["OWNERLESS", "PUBLISH", "RELEASE", "RECOVERY", "CLAIM", "CLAIMED", "FENCED", "VERIFIED", "TURN_PUBLISH", "TURN_SETTLE", "TURN_COLLECT"]
    .map((name) => `TC_TEST_PROFILE_LOCK_${name}_BARRIER_DIR`),
  "TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH",
  "TC_TEST_LOCK_PROTOCOL",
];

/** Environment for a lock child process: this test's TC_HOME, no inherited barriers or protocol. */
export function lockChildEnv(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
  for (const name of LOCK_TEST_ENVIRONMENT) delete env[name];
  return { ...env, ...extra };
}

export interface LockHolder {
  readonly pid: number;
  readonly readyPath: string;
  release(): Promise<void>;
  kill(): void;
  finished(): Promise<[number, string]>;
}

/**
 * A child that takes the lock once (hold-profile-lock.ts), signals `<name>-ready`
 * and holds until released. Exit 3 means it timed out without holding.
 */
export function spawnLockHolder(
  home: string,
  holders: string,
  profile: string,
  name: string,
  options: { timeoutMs: number; staleAfterMs: number; holdUntilReleased?: boolean; env?: Record<string, string> },
): LockHolder {
  const readyPath = join(home, `${name}-ready`);
  const releasePath = join(home, `${name}-release`);
  const child = Bun.spawn([process.execPath, holdFixture, profile, holders, readyPath, options.holdUntilReleased === false ? "-" : releasePath, String(options.timeoutMs), String(options.staleAfterMs)], {
    env: lockChildEnv(home, options.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    pid: child.pid,
    readyPath,
    release: () => writeFile(releasePath, "release\n", "utf8"),
    kill: () => child.kill("SIGKILL"),
    finished: async () => {
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return [exit, stderr];
    },
  };
}

/** A child that takes the lock `iterations` times (cycle-profile-lock.ts). */
export function spawnLockCycler(
  home: string,
  holders: string,
  profile: string,
  options: { iterations: number; staleAfterMs: number; protocol?: "current" | "tc540" | "pre-tc540" },
) {
  return Bun.spawn([process.execPath, cycleFixture, profile, holders, String(options.iterations), String(options.staleAfterMs)], {
    env: lockChildEnv(home, options.protocol ? { TC_TEST_LOCK_PROTOCOL: options.protocol } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Exit code and stderr of every child, in order. */
export function finishedChildren(children: readonly Bun.Subprocess[]): Promise<Array<readonly [number, string]>> {
  return Promise.all(children.map(async (child) => [
    await child.exited,
    await new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ] as const));
}

/** Overlapping critical sections the lock children recorded. */
export async function violations(holders: string): Promise<string[]> {
  return (await readdir(holders)).filter((name) => name.startsWith("violation-"));
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Makes `.lock` look a minute old, past the default stale threshold. */
export async function ageLock(profile: string): Promise<void> {
  const aMinuteAgo = new Date(Date.now() - 60_000);
  await utimes(profileLockPath(profile), aMinuteAgo, aMinuteAgo);
}
