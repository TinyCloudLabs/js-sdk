import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWorkerSizeToolchain, checkReplicaWorkerSize, checkWorkerSize, MAX_REPLICA_WORKER_GZIP_BYTES, MAX_WORKER_GZIP_BYTES } from "./check-worker-size";

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
test("uses the reviewed GitHub worker ceilings without additional headroom", () => {
  const ledger = JSON.parse(readFileSync(join(import.meta.dir, "../../web-sdk/scripts/replica-size-ledger.json"), "utf8")) as Record<string, { worker?: { ceiling: number } } | undefined>;
  const kvRows = Object.keys(ledger).filter((key) => key !== "tc1827ReplicaWorkerRatchet" && ledger[key]?.worker !== undefined);
  expect(MAX_WORKER_GZIP_BYTES).toBe(ledger[kvRows.at(-1)!]!.worker!.ceiling);
  expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(ledger.tc1827ReplicaWorkerRatchet!.worker!.ceiling);
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

test("measures replica.worker.js at gzip level 9 against its own threshold", () => {
  const bytes = Buffer.from("replica worker fixture".repeat(100));
  const { dir } = fixture(Buffer.from("kv-storage worker"));
  writeFileSync(join(dir, "replica.worker.js"), bytes);
  const measured = execFileSync("gzip", ["-9", "-c"], { input: bytes }).byteLength;
  expect(checkReplicaWorkerSize(dir, measured)).toEqual({ bytes: measured, headroom: 0 });
  expect(() => checkReplicaWorkerSize(dir, measured - 1)).toThrow(/Replica worker exceeds .* by 1 bytes/);
  expect(() => checkReplicaWorkerSize(dir, 0)).toThrow(/threshold/i);
});

test("rejects a missing replica worker", () => {
  const { dir } = fixture(Buffer.from("kv-storage worker"));
  expect(() => checkReplicaWorkerSize(dir)).toThrow(/replica\.worker\.js/);
});
