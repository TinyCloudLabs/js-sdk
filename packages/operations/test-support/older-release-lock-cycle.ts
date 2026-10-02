// A writer using the 842377d4 lock protocol: mkdir(.lock), then write
// owner.json with writeJsonAtomic; release removes owner.json and the
// directory. Takes the lock `iterations` times, recording overlapping holders.
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { profileLockMetadataPath, profileLockPath, profilePath, writeJsonAtomic } from "../src/state.js";

const [profile, holdersDir, iterations] = process.argv.slice(2);
if (!profile || !holdersDir || !iterations) throw new Error("Expected profile, holders dir and iterations.");

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const lockPath = profileLockPath(profile);
await mkdir(profilePath(profile), { recursive: true });

for (let index = 0; index < Number(iterations); index++) {
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await yieldToEventLoop();
    }
  }
  // The window the older release left open: `.lock` exists, still empty.
  await yieldToEventLoop();
  await writeJsonAtomic(profileLockMetadataPath(profile), { pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() });

  const active = join(holdersDir, "active");
  try {
    await writeFile(active, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
    for (let turn = 0; turn < 3; turn++) await yieldToEventLoop();
    await rm(active, { force: true });
  } catch {
    await writeFile(join(holdersDir, `violation-older-${process.pid}-${index}`), "two holders at once\n", "utf8");
  }
  await rm(profileLockMetadataPath(profile), { force: true });
  await rmdir(lockPath);
}
