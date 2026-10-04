// A separately bundled TC-602 copy may carry a held-lock entry without
// TC-633's turn slot. It must not make this version skip actual acquisition.
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFile } from "node:fs/promises";

const [profile, output] = process.argv.slice(2);
if (!profile || !output) throw new Error("Expected profile and output path.");
const legacyContext = new AsyncLocalStorage();
globalThis[Symbol.for("tinycloud.operations.heldProfileLocks.v1")] = legacyContext;
const state = await import("@tinycloud/operations/state");
const outcome = await legacyContext.run(
  [{ lockPath: state.profileLockPath(profile), active: true }],
  () => state.withProfileLock(profile, async () => "entered", { timeoutMs: 400, retryMs: 5 })
    .catch((error) => error.code ?? String(error)),
);
await writeFile(output, outcome);
