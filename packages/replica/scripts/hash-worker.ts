import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const worker = "kv-storage.worker.js";
const client = resolve(dist, "kv-storage.js");
const bytes = await readFile(resolve(dist, worker));
const digest = createHash("sha256").update(bytes).digest("hex");
const hashedWorker = `kv-storage.worker.${digest}.js`;
const originalUrl = `new URL("./${worker}", import.meta.url)`;
const code = await readFile(client, "utf8");
if (code.split(originalUrl).length !== 2) throw new Error(`Expected exactly one default worker URL in ${client}`);

// Keep a literal new URL for bundlers (not a runtime manifest lookup). The
// stable file remains for the static ./kv-storage/worker package export.
// tsup's source map still identifies the same source line; generated columns
// after the replaced URL literal on that line can shift.
await copyFile(resolve(dist, worker), resolve(dist, hashedWorker));
await writeFile(client, code.replace(originalUrl, `new URL("./${hashedWorker}", import.meta.url)`));
