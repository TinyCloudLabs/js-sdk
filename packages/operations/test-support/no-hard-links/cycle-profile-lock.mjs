// Takes the profile lock of the built @tinycloud/operations (as the CLI runs
// it, under Node) `iterations` times, recording overlapping holders. Run with
// no-hard-links.cjs preloaded. Exit 3: timed out without holding the lock.
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfileLockTimeoutError, withProfileLock } from "@tinycloud/operations/state";

const [profile, holdersDir, iterations, staleAfterMs, timeoutMs] = process.argv.slice(2);
if (!profile || !holdersDir || !iterations || !staleAfterMs || !timeoutMs) {
  throw new Error("Expected profile, holders dir, iterations, stale threshold and timeout.");
}

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

try {
  for (let index = 0; index < Number(iterations); index++) {
    await withProfileLock(profile, async () => {
      const active = join(holdersDir, "active");
      try {
        await writeFile(active, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
      } catch {
        await writeFile(join(holdersDir, `violation-${process.pid}-${index}`), "two holders at once\n", "utf8");
        return;
      }
      for (let turn = 0; turn < 3; turn++) await yieldToEventLoop();
      await rm(active, { force: true });
    }, { timeoutMs: Number(timeoutMs), staleAfterMs: Number(staleAfterMs), retryMs: 1 });
  }
} catch (error) {
  if (!(error instanceof ProfileLockTimeoutError)) throw error;
  process.exit(3);
}
