import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Baseline = { baselineRef: string; "index.mjs": number; "index.cjs": number };
const distDir = resolve(import.meta.dir, "../dist");
const baseline = JSON.parse(await readFile(resolve(import.meta.dir, "phase1-replica-baseline.json"), "utf8")) as Baseline;
console.log(`Gzip baseline: ${baseline.baselineRef}`);
let failed = false;
for (const filename of ["index.mjs", "index.cjs"] as const) {
  const source = await readFile(resolve(distDir, filename), "utf8");
  for (const forbidden of ["@tinycloud/replica", "tinycloud-replica"]) {
    if (source.includes(forbidden)) {
      console.error(`${filename}: forbidden replica reference ${JSON.stringify(forbidden)}`);
      failed = true;
    }
  }
  const current = execFileSync("gzip", ["-9", "-c", resolve(distDir, filename)], { maxBuffer: 10 * 1024 * 1024 }).byteLength;
  const delta = current - baseline[filename];
  console.log(`${filename}: baseline=${baseline[filename]} gzip-bytes current=${current} delta=${delta} bytes`);
  if (delta > 6 * 1024) {
    console.error(`${filename}: gzip delta ${delta} bytes exceeds the 6144-byte limit`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
