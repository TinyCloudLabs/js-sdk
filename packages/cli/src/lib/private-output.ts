import { randomUUID } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { PRIVATE_FILE_MODE } from "../config/storage.js";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

/** Validate the destination before fetching sensitive content. */
export async function validatePrivateOutput(path: string, label = "output"): Promise<void> {
  try {
    const destination = await lstat(path);
    if (!destination.isFile()) {
      throw new CLIError("INVALID_ARGUMENT", `${label} "${path}" must be a regular file, not a symlink, directory, or device.`, ExitCode.USAGE_ERROR);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
  try {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory()) {
      throw new CLIError("INVALID_ARGUMENT", `${label} "${path}" requires an existing directory parent.`, ExitCode.USAGE_ERROR);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
    throw new CLIError("INVALID_ARGUMENT", `${label} "${path}" requires an existing directory parent.`, ExitCode.USAGE_ERROR);
  }
}

/** Atomically replace a regular file with owner-only output and durable contents. */
export async function writePrivateOutput(path: string, value: string | Uint8Array, label = "output"): Promise<void> {
  await validatePrivateOutput(path, label);
  const parentPath = dirname(path);
  const temp = join(parentPath, `.${basename(path)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temp, "wx", PRIVATE_FILE_MODE);
    created = true;
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    if (created) await rm(temp, { force: true }).catch(() => undefined);
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
    throw new CLIError("ERROR", `Could not write ${label.toLowerCase()} "${path}"${code}.`, ExitCode.ERROR);
  }

  // After replacement, directory fsync is best effort: unsupported by some filesystems.
  try {
    const parent = await open(parentPath, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch {
    // The atomic rename already succeeded.
  }
}
