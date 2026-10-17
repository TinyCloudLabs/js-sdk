import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWorkerSizeToolchain, checkWorkerSize, MAX_WORKER_GZIP_BYTES } from "./check-worker-size";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(bytes: Buffer): { dir: string; canonical: string } {
  const dir = mkdtempSync(join(tmpdir(), "kv-worker-budget-"));
  directories.push(dir);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const canonical = `kv-storage.worker.${hash}.js`;
  writeFileSync(join(dir, canonical), bytes);
  writeFileSync(join(dir, "kv-storage.worker.js"), bytes);
  return { dir, canonical };
}

test("measures the canonical worker exactly once at gzip level 9", () => {
  const bytes = Buffer.from("inlined WASM worker fixture".repeat(100));
  const { dir } = fixture(bytes);
  const measured = execFileSync("gzip", ["-9", "-c"], { input: bytes }).byteLength;
  expect(checkWorkerSize(dir, measured)).toEqual({ bytes: measured, headroom: 0 });
});
test("uses the reviewed GitHub worker ceiling without additional headroom", () => {
  expect(MAX_WORKER_GZIP_BYTES).toBe(820_108);
});

test("refuses worker size measurements from a different Bun or Rust toolchain", () => {
  expect(() => assertWorkerSizeToolchain("1.3.14", "rustc 1.99.0 (b940084d7 2026-09-28)")).not.toThrow();
  expect(() => assertWorkerSizeToolchain("1.4.3", "rustc 1.99.0 (b940084d7 2026-09-28)")).toThrow(/Bun 1\.3\.14/);
  expect(() => assertWorkerSizeToolchain("1.3.14", "rustc 1.97.1 (8bab26f4f 2026-07-14)")).toThrow(/Rust 1\.99\.0/);
  expect(() => assertWorkerSizeToolchain("1.3.14", "unknown")).toThrow(/Rust 1\.99\.0/);
});

test("rejects a missing canonical artifact", () => {
  const { dir, canonical } = fixture(Buffer.from("worker"));
  rmSync(join(dir, canonical));
  expect(() => checkWorkerSize(dir)).toThrow(/canonical|hashed/i);
});

test("rejects a filename whose digest does not match the emitted bytes", () => {
  const { dir, canonical } = fixture(Buffer.from("worker"));
  writeFileSync(join(dir, canonical), "tampered");
  expect(() => checkWorkerSize(dir)).toThrow(/SHA-256|hash/i);
});

test("rejects a stable package-export alias with different bytes", () => {
  const { dir } = fixture(Buffer.from("worker"));
  writeFileSync(join(dir, "kv-storage.worker.js"), "stale worker");
  expect(() => checkWorkerSize(dir)).toThrow(/alias/i);
});

test("rejects excess gzip bytes and invalid thresholds", () => {
  const { dir } = fixture(Buffer.from("worker"));
  expect(() => checkWorkerSize(dir, 1)).toThrow(/exceeds/i);
  expect(() => checkWorkerSize(dir, NaN)).toThrow(/threshold/i);
  expect(() => checkWorkerSize(dir, 0)).toThrow(/threshold/i);
});
