import { watch } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Each contention test has two sequential parent signal waits: holder-ready
// and CLI-contention, followed by the holder and CLI completions. The 44s
// outer test bound is 2 * 12s parent waits + 2 * 8s child completions +
// 2s store/assertion allowance + 2s scheduler reserve. A child's exit and
// stderr closure are awaited concurrently, so each completion costs 8s.
export const PROFILE_LOCK_PARENT_SIGNAL_TIMEOUT_MS = 12_000;
export const PROFILE_LOCK_CHILD_NORMAL_EXIT_TIMEOUT_MS = 8_000;
export const PROFILE_LOCK_CHILD_STDERR_CLOSE_TIMEOUT_MS = 8_000;
export const PROFILE_LOCK_CHILD_SIGTERM_TIMEOUT_MS = 2_000;
export const PROFILE_LOCK_CHILD_SIGKILL_TIMEOUT_MS = 2_000;
export const PROFILE_LOCK_ASSERTION_MARGIN_MS = 2_000;
export const PROFILE_LOCK_OUTER_RESERVE_MS = 2_000;
export const PROFILE_LOCK_CHILD_COMPLETION_TIMEOUT_MS = Math.max(
  PROFILE_LOCK_CHILD_NORMAL_EXIT_TIMEOUT_MS,
  PROFILE_LOCK_CHILD_STDERR_CLOSE_TIMEOUT_MS,
);
export const PROFILE_LOCK_TEST_TIMEOUT_MS =
  (2 * PROFILE_LOCK_PARENT_SIGNAL_TIMEOUT_MS) +
  (2 * PROFILE_LOCK_CHILD_COMPLETION_TIMEOUT_MS) +
  PROFILE_LOCK_ASSERTION_MARGIN_MS +
  PROFILE_LOCK_OUTER_RESERVE_MS;

// The holder starts this clock when it signals ready. It therefore outlives
// the parent's 12s CLI startup/contention wait by a 3s release-handoff margin.
export const PROFILE_LOCK_HOLDER_RELEASE_MARGIN_MS = 3_000;
export const PROFILE_LOCK_HOLDER_RELEASE_TIMEOUT_MS =
  PROFILE_LOCK_PARENT_SIGNAL_TIMEOUT_MS + PROFILE_LOCK_HOLDER_RELEASE_MARGIN_MS;
export const PROFILE_LOCK_PROTOCOL_RECHECK_INTERVAL_MS = 50;

export async function signalProfileLockProtocol(filePath: string): Promise<void> {
  await writeFile(filePath, "ready\n", { encoding: "utf8", flag: "wx" });
}

/** Wait for an event-driven child-process signal, with a bounded test timeout. */
export async function waitForProfileLockProtocol(
  filePath: string,
  description: string,
  timeoutMs = PROFILE_LOCK_PARENT_SIGNAL_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) throw protocolWaitAborted(description);
  if (await exists(filePath)) return;

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let recheck: ReturnType<typeof setInterval> | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    const onAbort = () => finish(protocolWaitAborted(description));
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (recheck !== undefined) clearInterval(recheck);
      watcher?.close();
      abortSignal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      void exists(filePath).then((found) => {
        if (found) finish();
      }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    };
    watcher = watch(dirname(filePath), { persistent: false }, () => {
      // fs.watch may omit the filename and can coalesce directory events.
      // Rechecking is cheap and makes the file itself the protocol authority.
      check();
    });
    timeout = setTimeout(
      () => finish(new Error(`Timed out waiting for ${description}.`)),
      timeoutMs,
    );
    recheck = setInterval(check, PROFILE_LOCK_PROTOCOL_RECHECK_INTERVAL_MS);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) return onAbort();

    // Cover a signal written between the initial existence check and watch;
    // the bounded recheck also covers a dropped fs.watch notification.
    check();
  });
}

function protocolWaitAborted(description: string): Error {
  return new Error(`Stopped waiting for ${description}.`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
