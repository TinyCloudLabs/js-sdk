import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// TC-858: GitHub #548 measured 820,101 gzip bytes with Bun 1.3.14 / Rust 1.99.0.
// The old 818,196 cap used another toolchain: #550's same-toolchain worker is
// 820,073, and the reviewed grant-policy import adds 29 bytes on the candidate.
// The fix-before-stable worker start-up report (`main().catch(reportError)`, #565
// commit 89b82fc2) measured 820,108 (+7) in GitHub run 39004961403 jobs
// 117315431534 and 117315431611; the ledger's hardeningRatchet row records it.
// TC-1413 (typed node retry errors in sdk-services) measured 820,935 (+827) in
// GitHub run 39099093175 on 20c29611 (the same 820,935 as run 39095466871 on
// 50a9a83c); the ledger's tc1413Ratchet row records it.
// TC-1432 (vault etag, ifMatch and opt-in expectAad in sdk-services) measured 822,044 (+1,109) in
// GitHub run 39144311690 (head 83c9d75a, against master 129c7935 after #578 landed; the same 822,044
// as run 39134457380 on the earlier base); the ledger's tc1432Ratchet row records it.
// TC-1475 (automatic retry of NODE_BUSY / REQUEST_TIMEOUT in sdk-services, re-signing each attempt) measured 822,667 (+623) in
// GitHub run 39292038037 (source 09214408, against master 5317cc78; unchanged by the master merge); the ledger's tc1475Ratchet row records it.
// #606 (security dependency updates) measured 822,753 (+86) in GitHub run 39326132925 (master 54a2408d; #552 inherited it);
// approved by Naomi, 2026-10-19; the ledger's tc606WorkerRatchet row records it.
// #694 (TC-1827: replica workers import only the KV service and its ServiceContext) measured 776,128 (-46,625) in GitHub
// run 39943720009 (head 7a7303a8, merge base 6076581d); approved by Naomi, 2026-10-23; the ledger's tc1827WorkerRatchet row records it.
// Zero additional headroom; independent of the web-sdk ledger, including WASM.
// TC-2096 (#759: capped replica repair backoff) measured 776,468 (+340) in GitHub run 40343675308 (source c6b4703d);
// approved by Naomi; the ledger's tc2096RepairBackoffRatchet row records it. Zero additional headroom.
export const MAX_WORKER_GZIP_BYTES = 776_468;
// TC-1827 follow-up: `replica.worker.js` (the @tinycloud/replica/browser worker) is unhashed and had no ceiling. It
// measured 770,093 in GitHub run 39949887460 (head f2e2f9fc, merge base dc615834); requested by Naomi, 2026-10-23; the
// ledger's tc1827ReplicaWorkerRatchet row records it. Zero additional headroom.
// TC-2096 (#759) measured 770,416 (+323) in the same run 40343675308; the ledger's tc2096RepairBackoffRatchet row
// records it as replicaWorker. Zero additional headroom.
export const MAX_REPLICA_WORKER_GZIP_BYTES = 770_416;
const canonicalName = /^kv-storage\.worker\.([0-9a-f]{64})\.js$/;
const replicaWorkerName = "replica.worker.js";

export function assertWorkerSizeToolchain(bunVersion: string, rustcOutput: string): void {
  const rustcVersion = /^rustc (\d+\.\d+\.\d+)(?:\s|$)/.exec(rustcOutput)?.[1];
  if (bunVersion !== "1.3.14" || rustcVersion !== "1.99.0") {
    throw new Error(`Worker size requires Bun 1.3.14 and Rust 1.99.0; received Bun ${bunVersion} and ${rustcOutput}.`);
  }
}

function measureGzip(label: string, name: string, bytes: Buffer, maxBytes: number): { bytes: number; headroom: number } {
  // Feed the bytes on stdin: gzip -9's file-name header would otherwise
  // charge the 64-character hash as growth despite identical shipped JS/WASM.
  const size = execFileSync("gzip", ["-9", "-c"], { input: bytes, maxBuffer: 16 * 1024 * 1024 }).byteLength;
  const headroom = maxBytes - size;
  console.log(`${name}: ${size} gzip -9 bytes (stdin, filename-independent); threshold=${maxBytes}; headroom=${headroom} bytes`);
  if (headroom < 0) {
    throw new Error(`${label} exceeds reviewed gzip threshold by ${-headroom} bytes; change threshold only after review`);
  }
  return { bytes: size, headroom };
}

function assertThreshold(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid worker gzip threshold: ${maxBytes}`);
  }
}

export function checkWorkerSize(distDir: string, maxBytes = MAX_WORKER_GZIP_BYTES): { bytes: number; headroom: number } {
  assertThreshold(maxBytes);

  const candidates = readdirSync(distDir).filter((name) => canonicalName.test(name));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one canonical hashed kv-storage worker in ${distDir}; found ${candidates.length}`);
  }
  const [name] = candidates;
  const bytes = readFileSync(join(distDir, name));
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (name !== `kv-storage.worker.${actualHash}.js`) {
    throw new Error(`Worker SHA-256 filename hash does not match ${name}`);
  }
  const alias = readFileSync(join(distDir, "kv-storage.worker.js"));
  if (!alias.equals(bytes)) {
    throw new Error("Stable kv-storage.worker.js alias differs from the canonical hashed worker");
  }

  return measureGzip("Canonical kv-storage worker", name, bytes, maxBytes);
}

export function checkReplicaWorkerSize(distDir: string, maxBytes = MAX_REPLICA_WORKER_GZIP_BYTES): { bytes: number; headroom: number } {
  assertThreshold(maxBytes);
  return measureGzip("Replica worker", replicaWorkerName, readFileSync(join(distDir, replicaWorkerName)), maxBytes);
}

if (import.meta.main) {
  try {
    assertWorkerSizeToolchain(Bun.version, execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim());
    const dist = resolve(import.meta.dir, "../dist");
    for (const check of [checkWorkerSize, checkReplicaWorkerSize]) {
      try {
        check(dist);
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
