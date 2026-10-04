// Takes one profile lock `iterations` times, recording overlapping holders.
// The lock is the release TC_TEST_LOCK_PROTOCOL names (see lock-protocol.ts).
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFixtureLock } from "./lock-protocol.js";

const [profile, holdersDir, iterations, staleAfterMs] = process.argv.slice(2);
if (!profile || !holdersDir || !iterations || !staleAfterMs) {
  throw new Error("Expected profile, holders dir, iterations and stale threshold.");
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

for (let index = 0; index < Number(iterations); index++) {
  await withFixtureLock(profile, async () => {
    const active = join(holdersDir, "active");
    try {
      await writeFile(active, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
    } catch {
      await writeFile(join(holdersDir, `violation-${process.pid}-${index}`), "two holders at once\n", "utf8");
      return;
    }
    // Hold across a few event-loop turns so contenders' attempts interleave.
    for (let turn = 0; turn < 3; turn++) await yieldToEventLoop();
    await rm(active, { force: true });
  }, { timeoutMs: 30_000, staleAfterMs: Number(staleAfterMs), retryMs: 1 });
}
