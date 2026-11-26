/** The detached background update check (TC-2769), started by a command whose cached result is missing or a day old. */
import { checkForUpdate } from "./lib/auto-update.js";

const [currentVersion = "", cachePath = "", mode] = process.argv.slice(2);
if (mode === "--self-update") {
  // TC-4276: the same child also runs one auto-update pass, loaded only here. Its install lock's age cap ends it.
  const [{ runBackgroundUpdate }, { LOCK_MAX_AGE_MS }] = await Promise.all([import("./lib/self-update.js"), import("./lib/install-lock.js")]);
  setTimeout(() => process.exit(0), LOCK_MAX_AGE_MS).unref();
  await runBackgroundUpdate(currentVersion, cachePath).catch(() => undefined);
  process.exit(0);
}
// The request aborts on its own; this also ends a DNS lookup the abort can't cancel.
setTimeout(() => process.exit(0), 10_000).unref();
await checkForUpdate({ currentVersion, cachePath }).catch(() => null);
