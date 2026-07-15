import { access, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";

export const PROFILE_LOCK_PROTOCOL_TIMEOUT_MS = 5_000;

export async function signalProfileLockProtocol(filePath: string): Promise<void> {
  await writeFile(filePath, "ready\n", { encoding: "utf8", flag: "wx" });
}

/**
 * Wait on a filesystem event, with a timeout only to prevent a broken child
 * protocol from hanging the test. It intentionally has no polling or sleeps.
 */
export async function waitForProfileLockProtocol(
  filePath: string,
  description: string,
  timeoutMs = PROFILE_LOCK_PROTOCOL_TIMEOUT_MS,
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

    // Cover a signal written after the first existence check but before watch
    // began observing the directory.
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
