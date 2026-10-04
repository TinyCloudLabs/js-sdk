// The profile lock against released binaries' locks, paused processes and a
// filesystem without hard links (TC-633). Older writers run the frozen lock
// code of their release (test-support/released-locks). These tests use only
// state.ts exports that predate TC-633, so they run against earlier code too.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileLockMetadataPath, profileLockPath, profilePath, writeJsonAtomic } from "./state.js";
import { waitForProfileLockProtocol } from "./test-support/profile-lock-protocol.js";
import {
  ageLock,
  exists,
  finishedChildren,
  lockChildEnv,
  spawnLockCycler,
  spawnLockHolder,
  violations,
} from "./test-support/lock-children.js";

const originalTcHome = process.env.TC_HOME;
const homes: string[] = [];
const PROFILE = "delegate";

afterEach(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function lockTestHome(): Promise<{ home: string; holders: string }> {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-profile-lock-releases-"));
  homes.push(home);
  process.env.TC_HOME = home;
  const holders = join(home, "holders");
  await mkdir(holders, { recursive: true });
  await mkdir(profilePath(PROFILE), { recursive: true });
  return { home, holders };
}

/** Polls `check` until it holds (each check yields to the children), or fails after `timeoutMs`. */
async function waitUntil(check: () => Promise<boolean>, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
  }
}

/**
 * Whether this release's turn lock exists. It exists only where processes
 * of a release with the turn lock ran; there, a contender that signalled
 * contention while another process is paused holding a turn is blocked on
 * that turn.
 */
const turnLockExists = (home: string) => exists(join(home, ".tinycloud", "profile-locks", PROFILE));

test("an aged empty lock reclaimed by two writers never removes the lock a pre-TC-540 writer just created", async () => {
  const { home, holders } = await lockTestHome();
  const lockPath = profileLockPath(PROFILE);
  // Left by a crash between mkdir and the owner write, a minute ago.
  await mkdir(lockPath);
  await ageLock(PROFILE);

  // N1 has found the lock aged and stops before looking inside it.
  const barrier = join(home, "ownerless-barrier");
  await mkdir(barrier);
  const first = spawnLockHolder(home, holders, PROFILE, "first", { timeoutMs: 20_000, staleAfterMs: 30_000, holdUntilReleased: false, env: { TC_TEST_PROFILE_LOCK_OWNERLESS_BARRIER_DIR: barrier } });
  await waitForProfileLockProtocol(join(barrier, `ready-${first.pid}-${PROFILE}`), "N1 after its age check");

  // N2 reclaims the same lock and takes it, unless N1's turn excludes it.
  const contended = join(home, "second-contended");
  const second = spawnLockHolder(home, holders, PROFILE, "second", { timeoutMs: 20_000, staleAfterMs: 30_000, env: { TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contended } });
  await waitUntil(async () => await exists(second.readyPath) || (await exists(contended) && await turnLockExists(home)), "N2 to take the lock or wait for N1");
  const secondTookIt = await exists(second.readyPath);
  if (secondTookIt) {
    await second.release();
    const [exit, stderr] = await second.finished();
    expect(exit, stderr).toBe(0);
  }

  // A pre-TC-540 writer creates `.lock` as soon as it can: from its mkdir it
  // holds the lock, before writing its owner record.
  const olderHolds = await mkdir(lockPath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    return false;
  });
  const firstDone = first.finished();
  const children = [firstDone];
  if (olderHolds) {
    await writeFile(join(holders, "active"), "pre-tc540\n", { encoding: "utf8", flag: "wx" });
    // N1 resumes while the older writer holds the lock, and runs to its end.
    await writeFile(join(barrier, "release"), "release\n", "utf8");
    await firstDone;
    await writeJsonAtomic(profileLockMetadataPath(PROFILE), { pid: process.pid, createdAt: new Date().toISOString(), token: "pre-tc540" });
    await rm(join(holders, "active"), { force: true });
    await rm(profileLockMetadataPath(PROFILE));
    await rmdir(lockPath).catch(() => undefined);
  } else {
    // The aged lock is still in place: the older writer waits for it like
    // any writer of its release, while N1 resumes.
    const older = spawnLockCycler(home, holders, PROFILE, { iterations: 1, staleAfterMs: 30_000, protocol: "pre-tc540" });
    children.push(finishedChildren([older]).then(([result]) => result as [number, string]));
    await writeFile(join(barrier, "release"), "release\n", "utf8");
  }
  if (!secondTookIt) {
    await waitForProfileLockProtocol(second.readyPath, "N2 to take the lock after N1");
    await second.release();
    children.push(second.finished());
  }

  for (const [exit, stderr] of await Promise.all(children)) expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
}, 60_000);

const STRESS_ROUNDS = Number(process.env.TC_TEST_PROFILE_LOCK_STRESS_ROUNDS ?? 3);

test("writers of this release and pre-TC-540 writers contending from an aged empty lock never overlap", async () => {
  for (let round = 0; round < STRESS_ROUNDS; round++) {
    const { home, holders } = await lockTestHome();
    await mkdir(profileLockPath(PROFILE));
    await ageLock(PROFILE);
    const workers = [
      ...Array.from({ length: 3 }, () => spawnLockCycler(home, holders, PROFILE, { iterations: 3, staleAfterMs: 30_000 })),
      ...Array.from({ length: 2 }, () => spawnLockCycler(home, holders, PROFILE, { iterations: 3, staleAfterMs: 30_000, protocol: "pre-tc540" })),
    ];
    for (const [exit, stderr] of await finishedChildren(workers)) expect(exit, stderr).toBe(0);
    expect(await violations(holders), `round ${round}`).toEqual([]);
  }
}, 600_000);

async function deadHolderLock(createdAgoMs: number): Promise<void> {
  await mkdir(profileLockPath(PROFILE), { recursive: true });
  await writeJsonAtomic(profileLockMetadataPath(PROFILE), {
    pid: 999_999_999,
    createdAt: new Date(Date.now() - createdAgoMs).toISOString(),
    token: "dead-holder",
  });
}

test("a failed recovery claim cannot remove a pre-TC-540 writer's fresh empty lock", async () => {
  const { home, holders } = await lockTestHome();
  await deadHolderLock(3_600_000);
  const recovery = join(home, "recovery-barrier");
  const beforeOwner = join(home, "legacy-owner-barrier");
  await Promise.all([mkdir(recovery), mkdir(beforeOwner)]);

  // R has observed the dead owner, but has not claimed it yet.
  const recoverer = spawnLockHolder(home, holders, PROFILE, "recoverer", {
    timeoutMs: 20_000, staleAfterMs: 30_000,
    env: { TC_TEST_PROFILE_LOCK_RECOVERY_BARRIER_DIR: recovery },
  });
  await waitForProfileLockProtocol(join(recovery, `ready-${recoverer.pid}-${PROFILE}`), "R before its claim");
  // An older recoverer clears the dead record and releases its acquisition.
  const earlier = spawnLockHolder(home, holders, PROFILE, "earlier", {
    timeoutMs: 20_000, staleAfterMs: 30_000, holdUntilReleased: false,
    env: { TC_TEST_LOCK_PROTOCOL: "tc540" },
  });
  const [earlierExit, earlierError] = await earlier.finished();
  expect(earlierExit, earlierError).toBe(0);

  // W owns the directory from mkdir, even before it publishes owner.json.
  const writer = spawnLockHolder(home, holders, PROFILE, "writer", {
    timeoutMs: 20_000, staleAfterMs: 30_000,
    env: { TC_TEST_LOCK_PROTOCOL: "pre-tc540", TC_TEST_PROFILE_LOCK_PRE_TC540_OWNER_BARRIER_DIR: beforeOwner },
  });
  await waitForProfileLockProtocol(join(beforeOwner, `ready-${writer.pid}-${PROFILE}`), "W after its mkdir");
  await writeFile(join(recovery, "release"), "release\n", "utf8");

  // The broken recoverer removes W's directory after link(ENOENT), enters,
  // and W then publishes and enters as well. Leave W parked long enough for
  // R's attempt, then let both finish even when the assertion will fail.
  await Bun.sleep(500);
  const enteredBeforeOwner = await exists(recoverer.readyPath);
  const directoryStillHeld = await exists(profileLockPath(PROFILE));
  await writeFile(join(beforeOwner, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(writer.readyPath, "W holding its lock");
  await writer.release();
  const [writerExit, writerError] = await writer.finished();
  expect(writerExit, writerError).toBe(0);
  await waitForProfileLockProtocol(recoverer.readyPath, "R acquiring after W");
  await recoverer.release();
  const [recovererExit, recovererError] = await recoverer.finished();
  expect(recovererExit, recovererError).toBe(0);
  expect(directoryStillHeld).toBe(true);
  expect(enteredBeforeOwner).toBe(false);
  expect(await violations(holders)).toEqual([]);
}, 60_000);

test("a paused recoverer never moves a live owner aside for older cleanup", async () => {
  const { home, holders } = await lockTestHome();
  await deadHolderLock(3_600_000);
  const verified = join(home, "verified-barrier");
  const claimed = join(home, "claim-barrier");
  await Promise.all([mkdir(verified), mkdir(claimed)]);
  const recoverer = spawnLockHolder(home, holders, PROFILE, "recoverer", {
    timeoutMs: 20_000, staleAfterMs: 600_000,
    env: { TC_TEST_PROFILE_LOCK_VERIFIED_BARRIER_DIR: verified, TC_TEST_PROFILE_LOCK_CLAIM_BARRIER_DIR: claimed },
  });
  await waitForProfileLockProtocol(join(verified, `ready-${recoverer.pid}-${PROFILE}`), "R after checking its claim");

  // On the broken protocol, T1 removes R's aged .stale-* probe, recovers
  // the dead record, then holds a live owner.json. With .recover-* R's claim
  // cannot be removed by T1, irrespective of its stale threshold.
  const first = spawnLockHolder(home, holders, PROFILE, "first-older", {
    timeoutMs: 20_000, staleAfterMs: 20, env: { TC_TEST_LOCK_PROTOCOL: "tc540" },
  });
  await Bun.sleep(500);
  const firstHeldWhileVerified = await exists(first.readyPath);
  await writeFile(join(verified, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(join(claimed, `ready-${recoverer.pid}-${PROFILE}`), "R at its owner removal");

  // With the broken protocol, R moved T1's live owner record into .stale-*.
  // T2 ages that claim out and takes the lock while T1 still holds it.
  const second = spawnLockHolder(home, holders, PROFILE, "second-older", {
    timeoutMs: 20_000, staleAfterMs: 20, env: { TC_TEST_LOCK_PROTOCOL: "tc540" },
  });
  await Bun.sleep(500);
  const secondHeldWhilePaused = await exists(second.readyPath);
  await writeFile(join(claimed, "release"), "release\n", "utf8");
  if (firstHeldWhileVerified) {
    await first.release();
    const [exit, stderr] = await first.finished();
    expect(exit, stderr).toBe(0);
  }
  if (secondHeldWhilePaused) {
    await second.release();
    const [exit, stderr] = await second.finished();
    expect(exit, stderr).toBe(0);
  }
  await waitForProfileLockProtocol(recoverer.readyPath, "R to acquire after its claim");
  await recoverer.release();
  const [recovererExit, recovererError] = await recoverer.finished();
  expect(recovererExit, recovererError).toBe(0);
  const pending = [first, second].filter((holder) =>
    holder === first ? !firstHeldWhileVerified : !secondHeldWhilePaused);
  if (pending.length === 2) {
    await waitUntil(async () => await exists(first.readyPath) || await exists(second.readyPath), "one older writer to acquire");
    const next = await exists(first.readyPath) ? first : second;
    await next.release();
    const [exit, stderr] = await next.finished();
    expect(exit, stderr).toBe(0);
    pending.splice(pending.indexOf(next), 1);
  }
  for (const holder of pending) {
    await waitForProfileLockProtocol(holder.readyPath, "remaining older writer to acquire");
    await holder.release();
    const [exit, stderr] = await holder.finished();
    expect(exit, stderr).toBe(0);
  }
  expect(firstHeldWhileVerified).toBe(false);
  expect(secondHeldWhilePaused).toBe(false);
  expect(await violations(holders)).toEqual([]);
}, 60_000);

for (const other of ["current", "tc540"] as const) {
  test(`a recoverer paused after confirming a dead owner never removes the record of a holder that came after (other: ${other})`, async () => {
    const { home, holders } = await lockTestHome();
    await deadHolderLock(3_600_000);

    // R1 has claimed the dead record, confirmed it, and is paused just before
    // unlinking owner.json. A 10-minute stale threshold keeps any time-based
    // fence of R1's from tripping.
    const verified = join(home, "verified-barrier");
    await mkdir(verified);
    const paused = spawnLockHolder(home, holders, PROFILE, "paused", { timeoutMs: 20_000, staleAfterMs: 600_000, holdUntilReleased: false, env: { TC_TEST_PROFILE_LOCK_VERIFIED_BARRIER_DIR: verified } });
    await waitForProfileLockProtocol(join(verified, `ready-${paused.pid}-${PROFILE}`), "R1 holding its confirmed claim");

    // R2 (20 ms stale threshold) may recover the same dead owner, but R1's
    // .recover-* claim cannot be removed by an older process; R2 must wait
    // for R1 to finish (or for its turn, if also of this release).
    const contended = join(home, "other-contended");
    const env: Record<string, string> = { TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contended };
    if (other === "tc540") env.TC_TEST_LOCK_PROTOCOL = "tc540";
    const holder = spawnLockHolder(home, holders, PROFILE, "holder", { timeoutMs: 20_000, staleAfterMs: 20, env });
    if (other === "current") {
      await waitUntil(async () => await exists(holder.readyPath) || (await exists(contended) && await turnLockExists(home)), "R2 to take the lock or wait for R1's turn");
    } else {
      // A TC-540 R2 that cannot take the lock just keeps retrying; there is
      // no event for "tried and failed". Give it real time to remove the
      // dead record and try the ownerless directory, which remains guarded
      // by R1's claim past R2's 20 ms stale threshold.
      await waitUntil(async () => await exists(holder.readyPath) || !await exists(profileLockMetadataPath(PROFILE)), "R2 to recover the dead record");
      if (!await exists(holder.readyPath)) await Bun.sleep(500);
    }

    // R1 resumes and takes the lock once (it does not wait to be released);
    // R2 takes it before or after R1 and holds until released.
    const otherHeldFirst = await exists(holder.readyPath);
    await writeFile(join(verified, "release"), "release\n", "utf8");
    if (otherHeldFirst) {
      // R2 got in while R1 was paused. R1 must not take the lock while R2
      // still holds it: give it the chance to (it would at once).
      await waitUntil(() => exists(paused.readyPath), "R1 to take the lock", 3_000).catch(() => undefined);
    }
    await waitForProfileLockProtocol(holder.readyPath, "R2 to take the lock");
    await holder.release();
    for (const [exit, stderr] of await Promise.all([paused.finished(), holder.finished()])) expect(exit, stderr).toBe(0);
    expect(await violations(holders)).toEqual([]);
  }, 60_000);
}

// The CLI runs the built package under Node; Node can make every hard link
// fail (Bun cannot replace node:fs bindings), as on FAT/exFAT or some SMB
// mounts. Run `bun run --cwd packages/operations build` first.
const node = Bun.which("node");
const twoInstances = new URL("../test-support/two-instances.mjs", import.meta.url).pathname;

test("built ESM and CJS copies in one PID do not settle one another's active turn", async () => {
  const { home } = await lockTestHome();
  if (!node) throw new Error("These tests need Node on PATH, as the CLI does.");
  const outcome = join(home, "two-instances.json");
  const child = Bun.spawn([node, twoInstances, PROFILE, outcome], {
    env: lockChildEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stderr] = (await finishedChildren([child]))[0]!;
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(await readFile(outcome, "utf8"))).toEqual({
    distinct: true,
    other: "PROFILE_LOCK_TIMEOUT",
    heldTurnSettled: false,
  });
}, 30_000);
const noHardLinks = new URL("../test-support/no-hard-links/no-hard-links.cjs", import.meta.url).pathname;
const nodeCycler = new URL("../test-support/no-hard-links/cycle-profile-lock.mjs", import.meta.url).pathname;

function spawnNodeCycler(home: string, holders: string, options: { iterations: number; timeoutMs: number }) {
  if (!node) throw new Error("These tests need Node on PATH, as the CLI does.");
  return Bun.spawn([node, "-r", noHardLinks, nodeCycler, PROFILE, holders, String(options.iterations), "30000", String(options.timeoutMs)], {
    env: lockChildEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("without hard links, writers of this release and pre-TC-540 writers share the lock without overlap", async () => {
  const { home, holders } = await lockTestHome();
  const workers = [
    ...Array.from({ length: 3 }, () => spawnNodeCycler(home, holders, { iterations: 20, timeoutMs: 30_000 })),
    ...Array.from({ length: 2 }, () => spawnLockCycler(home, holders, PROFILE, { iterations: 20, staleAfterMs: 30_000, protocol: "pre-tc540" })),
  ];
  for (const [exit, stderr] of await finishedChildren(workers)) expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
  expect(await exists(profileLockPath(PROFILE))).toBe(false);
}, 120_000);

test("without hard links, a dead holder's lock is recovered, and an incomplete owner record only once aged", async () => {
  const { home, holders } = await lockTestHome();
  const takeOnce = async (timeoutMs: number) => (await finishedChildren([spawnNodeCycler(home, holders, { iterations: 1, timeoutMs })]))[0]!;

  await deadHolderLock(60_000);
  const [recoveredExit, recoveredError] = await takeOnce(10_000);
  expect(recoveredExit, recoveredError).toBe(0);
  expect(await exists(profileLockPath(PROFILE))).toBe(false);

  // An owner record a crashed writer left empty, as an exclusive create
  // without hard links can: held while fresh, recovered once aged.
  await mkdir(profileLockPath(PROFILE));
  await writeFile(profileLockMetadataPath(PROFILE), "", "utf8");
  const [freshExit] = await takeOnce(300);
  expect(freshExit).toBe(3);
  expect(await readFile(profileLockMetadataPath(PROFILE), "utf8")).toBe("");
  const aMinuteAgo = new Date(Date.now() - 60_000);
  await utimes(profileLockMetadataPath(PROFILE), aMinuteAgo, aMinuteAgo);
  const [agedExit, agedError] = await takeOnce(10_000);
  expect(agedExit, agedError).toBe(0);
  expect(await exists(profileLockPath(PROFILE))).toBe(false);
  expect(await violations(holders)).toEqual([]);
}, 60_000);
