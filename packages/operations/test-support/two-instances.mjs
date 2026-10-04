// Loads the built @tinycloud/operations state entry point twice in one process,
// as ES module and as CommonJS: two module instances, as the CLI's several
// entry points are. While one instance holds the profile lock, the other must
// wait for its turn, never settle it. Writes the outcome as JSON to `out`.
import { readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import * as esm from "@tinycloud/operations/state";

const cjs = createRequire(import.meta.url)("@tinycloud/operations/state");
const [profile, out] = process.argv.slice(2);
if (!profile || !out) throw new Error("Expected profile and output path.");

let entered;
const inside = new Promise((resolve) => { entered = resolve; });
let finish;
const finished = new Promise((resolve) => { finish = resolve; });
const holding = esm.withProfileLock(profile, async () => {
  entered();
  await finished;
});
await inside;

// Outside the holder's async context, so this is a separate acquisition.
const turns = esm.profileTurnLockPath(profile);
const slot = Math.max(...(await readdir(turns)).filter((name) => /^\d+$/.test(name)).map(Number));
const other = await cjs.withProfileLock(profile, async () => "entered", { timeoutMs: 300, retryMs: 5 })
  .catch((error) => error.code ?? String(error));
const heldTurn = join(turns, String(slot));
const heldTurnSettled = !await stat(heldTurn).then(() => true, () => false) ||
  (await readdir(heldTurn)).some((name) => name.endsWith(".done"));
finish();
await holding;
await writeFile(out, JSON.stringify({ distinct: esm.withProfileLock !== cjs.withProfileLock, other, heldTurnSettled }));
