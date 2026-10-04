// Holds one profile lock in a child process and records overlapping holders.
// The lock is the release TC_TEST_LOCK_PROTOCOL names (see lock-protocol.ts).
// Exit 0: held and released. Exit 3: timed out without ever holding it.
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfileLockTimeoutError } from "../src/state.js";
import { withFixtureLock } from "./lock-protocol.js";
import {
  PROFILE_LOCK_HOLDER_RELEASE_TIMEOUT_MS,
  signalProfileLockProtocol,
  waitForProfileLockProtocol,
} from "../src/test-support/profile-lock-protocol.js";

const [profile, holdersDir, readyPath, releasePath, timeoutMs, staleAfterMs] = process.argv.slice(2);
if (!profile || !holdersDir || !readyPath || !releasePath || !timeoutMs || !staleAfterMs) {
  throw new Error("Expected profile, holders dir, ready path, release path ('-' for none), timeout and stale threshold.");
}

try {
  await withFixtureLock(profile, async () => {
    const active = join(holdersDir, "active");
    try {
      await writeFile(active, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
    } catch {
      await writeFile(join(holdersDir, `violation-${process.pid}`), "two holders at once\n", "utf8");
    }
    await signalProfileLockProtocol(readyPath);
    if (releasePath !== "-") {
      await waitForProfileLockProtocol(releasePath, "the parent to release the profile lock", PROFILE_LOCK_HOLDER_RELEASE_TIMEOUT_MS);
    }
    await rm(active, { force: true });
  }, { timeoutMs: Number(timeoutMs), staleAfterMs: Number(staleAfterMs), retryMs: 2 });
} catch (error) {
  if (!(error instanceof ProfileLockTimeoutError)) throw error;
  process.exit(3);
}
