import { watch } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

// Each contention test has two sequential parent signal waits: holder-ready
// and CLI-contention. The 36s outer test bound is 2 * 12s parent waits +
// 2 * 4s child exits + 2s store/assertion allowance + 2s scheduler reserve.
export const PROFILE_LOCK_PARENT_SIGNAL_TIMEOUT_MS = 12_000;
export const PROFILE_LOCK_CHILD_EXIT_TIMEOUT_MS = 4_000;
export const PROFILE_LOCK_ASSERTION_MARGIN_MS = 2_000;
export const PROFILE_LOCK_OUTER_RESERVE_MS = 2_000;
export const PROFILE_LOCK_TEST_TIMEOUT_MS =
  (2 * PROFILE_LOCK_PARENT_SIGNAL_TIMEOUT_MS) +
  (2 * PROFILE_LOCK_CHILD_EXIT_TIMEOUT_MS) +
  PROFILE_LOCK_ASSERTION_MARGIN_MS +
  PROFILE_LOCK_OUTER_RESERVE_MS;

// The holder starts this clock when it signals ready. It therefore outlives
// the parent's 12s CLI startup/contention wait by a 3s release-handoff margin.
export const PROFILE_LOCK_HOLDER_RELEASE_MARGIN_MS = 3_000;
export const PROFILE_LOCK_HOLDER_RELEASE_TIMEOUT_MS =
  PROFILE_LOCK_PARENT_SIGNAL_TIMEOUT_MS + PROFILE_LOCK_HOLDER_RELEASE_MARGIN_MS;

export async function signalProfileLockProtocol(filePath: string): Promise<void> {
  await writeFile(filePath, "ready\n", { encoding: "utf8", flag: "wx" });
}

/** Wait for an event-driven child-process signal, with a bounded test timeout. */
export async function waitForProfileLockProtocol(
  filePath: string,
  description: string,
  timeoutMs = PROFILE_LOCK_PARENT_SIGNAL_TIMEOUT_MS,
): Promise<void> {
  if (await exists(filePath)) return;

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      watcher.close();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      void exists(filePath).then((found) => {
        if (found) finish();
      }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    };
    const watcher = watch(dirname(filePath), { persistent: false }, (_event, changed) => {
      if (changed === basename(filePath)) check();
    });
    const timeout = setTimeout(
      () => finish(new Error(`Timed out waiting for ${description}.`)),
      timeoutMs,
    );

    // Cover a signal written between the initial existence check and watch.
    check();
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
