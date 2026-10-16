import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// TC-858: GitHub #548 measured 820,101 gzip bytes with Bun 1.3.14 / Rust 1.99.0.
// The old 818,196 cap used another toolchain: #550's same-toolchain worker is
// 820,073, and the reviewed grant-policy import adds 29 bytes on the candidate.
// Zero additional headroom; independent of the web-sdk ledger, including WASM.
export const MAX_WORKER_GZIP_BYTES = 820_101;
const canonicalName = /^kv-storage\.worker\.([0-9a-f]{64})\.js$/;

export function checkWorkerSize(distDir: string, maxBytes = MAX_WORKER_GZIP_BYTES): { bytes: number; headroom: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid worker gzip threshold: ${maxBytes}`);
  }

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

  // Feed canonical bytes on stdin: gzip -9's file-name header would otherwise
  // charge the 64-character hash as growth despite identical shipped JS/WASM.
  const size = execFileSync("gzip", ["-9", "-c"], { input: bytes, maxBuffer: 16 * 1024 * 1024 }).byteLength;
  const headroom = maxBytes - size;
  console.log(`${name}: ${size} gzip -9 bytes (stdin, filename-independent); threshold=${maxBytes}; headroom=${headroom} bytes`);
  if (headroom < 0) {
    throw new Error(`Canonical kv-storage worker exceeds reviewed gzip threshold by ${-headroom} bytes; change threshold only after review`);
  }
  return { bytes: size, headroom };
}

if (import.meta.main) {
  try {
    checkWorkerSize(resolve(import.meta.dir, "../dist"));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
