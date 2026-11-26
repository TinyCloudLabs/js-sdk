/** The detached background update check (TC-2769), started by a command whose cached result is missing or a day old. */
import { checkForUpdate } from "./lib/auto-update.js";

const [currentVersion = "", cachePath = ""] = process.argv.slice(2);
// The request aborts on its own; this also ends a DNS lookup the abort can't cancel.
setTimeout(() => process.exit(0), 10_000).unref();
await checkForUpdate({ currentVersion, cachePath }).catch(() => null);
