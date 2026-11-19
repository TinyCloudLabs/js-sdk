// A helper process a test spawns must not outlive that test. afterEach stops
// it only while the test runner is alive to run afterEach; a runner killed by
// a timeout or SIGKILL would otherwise orphan it, still polling. Plain ESM so
// that both the Bun helpers and the Node helpers (which run the built package
// under Node 20, without TypeScript) load it.
import { writeSync } from "node:fs";

/** Carries PROFILE_LOCK_HELPER_DEADLINE_MS to Node helpers, which cannot import TypeScript. */
export const HELPER_DEADLINE_ENV = "TC_TEST_HELPER_DEADLINE_MS";

// Well within the at-most-a-second bound on noticing a dead parent.
const PARENT_CHECK_INTERVAL_MS = 100;

/**
 * Ends this process with exit code 1 as soon as its parent is gone (reparented
 * or no longer exists), or at `deadlineMs` should that check fail. The checks
 * run on timers, so they also fire while the helper awaits a signal, a lock or
 * a test barrier. Call first in a helper's entry module. PID 1 of a new PID
 * namespace has no parent it can see (ppid 0), so only its deadline applies.
 */
export function exitWithParent(deadlineMs = Number(process.env[HELPER_DEADLINE_ENV])) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`Expected a positive helper deadline; spawn Node helpers with ${HELPER_DEADLINE_ENV} set.`);
  }
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent || !exists(parent)) exitHelper(`its parent process ${parent} exited`);
  }, PARENT_CHECK_INTERVAL_MS).unref();
  setTimeout(() => exitHelper(`it ran past its ${deadlineMs}ms deadline`), deadlineMs).unref();
}

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/** Ends the helper with exit code 1, saying why on stderr. */
export function exitHelper(reason) {
  try {
    // Synchronous: process.exit would drop a pending stream write.
    writeSync(2, `Test helper ${process.pid} exiting: ${reason}.\n`);
  } catch {
    // Nobody may be reading stderr any more.
  }
  process.exit(1);
}
