// Prototype fixture: one profile-lock holder or contender, run as PID 1 of a
// fresh PID namespace by profile-lock-namespaces.test.ts. The holder prints
// "ready" once inside its critical section and leaves it when stdin closes.
import { existsSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { profileTurnLockPath, withProfileLock } from "@tinycloud/operations/state";

const [mode, out, timeoutMs = "2000"] = process.argv.slice(2);
const marker = join(process.env.TC_HOME, "inside");
if (mode === "hold") {
  await withProfileLock("probe", async () => {
    await writeFile(marker, String(process.pid));
    const released = new Promise((resolve) => process.stdin.once("end", resolve).resume());
    process.stdout.write("ready\n");
    await released;
    await rm(marker, { force: true });
  }, { timeoutMs: 60_000 });
} else {
  let overlap = false;
  const outcome = await withProfileLock("probe", async () => {
    overlap = existsSync(marker);
    return "entered";
  }, { timeoutMs: Number(timeoutMs), retryMs: 1, staleAfterMs: 10 }).catch((error) => error.code ?? String(error));
  const leftovers = (await readdir(profileTurnLockPath("probe"))).filter((name) => name.startsWith("."));
  await writeFile(out, JSON.stringify({ pid: process.pid, outcome, overlap, leftovers }));
}
