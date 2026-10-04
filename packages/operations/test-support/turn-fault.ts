// A long-lived writer (as an MCP server is) that takes the profile lock once,
// stays alive, and takes it again when told. Each outcome ("ok" or the error
// code) is written to `<signals>/first` and `<signals>/second`. With a third
// argument "hold", the first critical section signals `<signals>/holding`
// and waits for `<signals>/release` before ending. Records overlapping holders.
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withProfileLock } from "../src/state.js";
import { signalProfileLockProtocol, waitForProfileLockProtocol } from "../src/test-support/profile-lock-protocol.js";

const [profile, holdersDir, signals, mode] = process.argv.slice(2);
if (!profile || !holdersDir || !signals) throw new Error("Expected profile, holders dir and signals dir.");

async function takeLock(hold: boolean): Promise<string> {
  try {
    await withProfileLock(profile!, async () => {
      const active = join(holdersDir!, "active");
      try {
        await writeFile(active, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
      } catch {
        await writeFile(join(holdersDir!, `violation-${process.pid}`), "two holders at once\n", "utf8");
      }
      if (hold) {
        await signalProfileLockProtocol(join(signals!, "holding"));
        await waitForProfileLockProtocol(join(signals!, "release"), "the parent to release the lock", 60_000);
      }
      await rm(active, { force: true });
    }, { timeoutMs: 10_000, retryMs: 5 });
    return "ok";
  } catch (error) {
    return String((error as { code?: unknown }).code ?? error);
  }
}

/** Writes an outcome file whole, so a watcher never reads it half-written. */
async function report(name: string, outcome: string): Promise<void> {
  await writeFile(join(signals!, `${name}.tmp`), outcome, "utf8");
  await rename(join(signals!, `${name}.tmp`), join(signals!, name));
}

await report("first", await takeLock(mode === "hold"));
await waitForProfileLockProtocol(join(signals, "retry"), "the parent to ask for a second acquisition", 60_000);
await report("second", await takeLock(false));
