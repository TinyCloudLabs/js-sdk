import "../test-support/test-bootstrap.mjs";
import { randomUUID } from "node:crypto";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fileSystem from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { profileTurnLockPath, withProfileLock } from "./state.js";
import { waitForProfileLockProtocol } from "./test-support/profile-lock-protocol.js";

// TC-3208: a process that published a turn from a stale read finds the turn before it gone, and reads that turn's owner
// record to confirm it. A turn number can be published again while it is read (the design allows a paused process to do
// it), so a read that found no owner record and then found the directory present must read the record again instead of
// calling the turn unreadable: a directory is published whole, with its owner record inside.

const originalTcHome = process.env.TC_HOME;
const originalHome = process.env.HOME;
const originalNodeEnv = process.env.NODE_ENV;
const originalBarrier = process.env.TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR;
const homes: string[] = [];

afterEach(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalBarrier === undefined) delete process.env.TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR;
  else process.env.TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR = originalBarrier;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** A turn directory as the lock publishes it: the owner record, plus the markers it has so far. */
async function writeTurn(turns: string, slot: number, token: string, markers: readonly ("held" | "done")[]): Promise<void> {
  const directory = join(turns, String(slot));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token, after: null })}\n`);
  for (const marker of markers) await writeFile(join(directory, `${token}.${marker}`), "");
}

test("a turn number published again while a stale publisher reads it is read again, not called unreadable", async () => {
  const home = await mkdtemp(join("/var/tmp", "tinycloud-operations-turn-race-"));
  homes.push(home);
  process.env.TC_HOME = home;
  process.env.HOME = homedir();
  process.env.NODE_ENV = "test";
  const profile = "delegate";
  const turns = profileTurnLockPath(profile);
  const publishBarrier = join(home, "turn-publish-barrier");
  await mkdir(publishBarrier);
  process.env.TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR = publishBarrier;

  // P creates the turn lock, reads turn 0 and stops before publishing turn 1.
  let ran = false;
  const writing = withProfileLock(profile, async () => { ran = true; }, { timeoutMs: 10_000, staleAfterMs: 30_000 });
  await waitForProfileLockProtocol(join(publishBarrier, `ready-${process.pid}-${profile}`), "P about to publish turn 1");

  // Others have moved on: turn 2 is granted and finished, and turn 0 has been removed.
  await writeTurn(turns, 2, randomUUID(), ["held", "done"]);
  await rm(join(turns, "0"), { recursive: true });

  // Turn 0 comes back, complete, between P's failed read of its owner record and P's look at the directory: a paused
  // process of an older read publishing that number again.
  const comeback = randomUUID();
  let armed = false;
  let republished = false;
  const realStat = fileSystem.stat;
  const statSpy = spyOn(fileSystem, "stat").mockImplementation((async (path: Parameters<typeof realStat>[0], options?: Parameters<typeof realStat>[1]) => {
    if (armed && !republished && String(path).endsWith("/0")) {
      republished = true;
      await writeTurn(turns, 0, comeback, []);
    }
    return realStat(path, options);
  }) as typeof realStat);
  try {
    armed = true;
    await writeFile(join(publishBarrier, "release"), "release\n", "utf8");
    // P republishes turn 1, finds turn 0 holding another token, leaves turn 1 void, and takes the lock after turn 2.
    await writing;
  } finally {
    statSpy.mockRestore();
  }
  expect(republished).toBe(true);
  expect(ran).toBe(true);
  expect(JSON.parse(await readFile(join(turns, "0", "owner.json"), "utf8"))).toMatchObject({ token: comeback });
}, 30_000);
