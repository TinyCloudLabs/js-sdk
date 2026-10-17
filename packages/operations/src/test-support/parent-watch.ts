// A helper process a test spawns must not outlive that test. afterEach stops
// it only while the test runner is alive to run afterEach; a runner killed by
// a timeout or SIGKILL would otherwise orphan it, still polling.
import { writeSync } from "node:fs";
import {
  PROFILE_LOCK_HELPER_DEADLINE_MS,
  PROFILE_LOCK_PROTOCOL_RECHECK_INTERVAL_MS,
} from "./profile-lock-protocol.js";

/**
 * Ends this process with exit code 1 as soon as its parent is gone (reparented
 * or no longer exists), or at PROFILE_LOCK_HELPER_DEADLINE_MS should that check
 * fail. The checks run on timers, so they also fire while the helper awaits a
 * signal, a lock or a test barrier. Call first in a helper's entry module.
 */
export function exitWithParent(): void {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent || !exists(parent)) end(`its parent process ${parent} exited`);
  }, PROFILE_LOCK_PROTOCOL_RECHECK_INTERVAL_MS).unref();
  setTimeout(
    () => end(`it ran past its ${PROFILE_LOCK_HELPER_DEADLINE_MS}ms deadline`),
    PROFILE_LOCK_HELPER_DEADLINE_MS,
  ).unref();
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function end(reason: string): never {
  try {
    // Synchronous: process.exit would drop a pending stream write.
    writeSync(2, `Test helper ${process.pid} exiting: ${reason}.\n`);
  } catch {
    // Nobody may be reading stderr any more.
  }
  process.exit(1);
}
