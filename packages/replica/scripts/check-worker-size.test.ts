import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkerSize } from "./check-worker-size";

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
