import { describe, expect, test } from "bun:test";

import { measureSealedRow, opaqueId, openSealed, seal } from "./sealed.js";

const key = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const text = new TextEncoder();

describe("origin replica ciphertext", () => {
  test("round-trips bytes under a versioned AES-GCM envelope without storing plaintext", async () => {
    const secret = await key();
    const payload = text.encode("s1-recognizable-account-content");
    const sealed = await seal(secret, payload, "blobs\u0000partition-A\u0000hash-A");
    expect(sealed.v).toBe(1);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.bytes).not.toEqual(payload);
    expect(new TextDecoder().decode(sealed.bytes)).not.toContain("s1-recognizable-account-content");
    expect(await openSealed(secret, sealed, "blobs\u0000partition-A\u0000hash-A")).toEqual(payload);
    expect((await seal(secret, payload, "blobs\u0000partition-A\u0000hash-A")).iv).not.toEqual(sealed.iv);
  });

  test("refuses swapped partition, changed row, wrong key, tampering and plaintext rows", async () => {
    const secret = await key();
    const other = await key();
    const sealed = await seal(secret, text.encode("private"), "entries\u0000partition-A\u0000key-A");
    await expect(openSealed(secret, sealed, "entries\u0000partition-B\u0000key-A")).rejects.toThrow();
    await expect(openSealed(secret, sealed, "entries\u0000partition-A\u0000key-B")).rejects.toThrow();
    await expect(openSealed(other, sealed, "entries\u0000partition-A\u0000key-A")).rejects.toThrow();
    const tampered = { ...sealed, bytes: sealed.bytes.slice() };
    tampered.bytes[0] = (tampered.bytes[0] ?? 0) ^ 1;
    await expect(openSealed(secret, tampered, "entries\u0000partition-A\u0000key-A")).rejects.toThrow();
    await expect(openSealed(secret, { bytes: text.encode("private") }, "entries\u0000partition-A\u0000key-A")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(openSealed(secret, { ...sealed, v: 2 }, "entries\u0000partition-A\u0000key-A")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  test("opaque primary keys are account-keyed and domain-separated", async () => {
    const secret = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const other = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const id = await opaqueId(secret, "entries", "partition-A", "notes/private");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(await opaqueId(secret, "entries", "partition-A", "notes/private"));
    expect(id).not.toBe(await opaqueId(other, "entries", "partition-A", "notes/private"));
    expect(id).not.toBe(await opaqueId(secret, "entries", "partition-B", "notes/private"));
    expect(id).not.toBe(await opaqueId(secret, "blobs", "partition-A", "notes/private"));
    expect(id).not.toBe(await opaqueId(secret, "entries", "partition-A", "notes/public"));
  });

  test("counts encrypted entry bytes, tag, key and all persisted field framing", async () => {
    const pid = "a".repeat(64);
    const id = "b".repeat(64);
    const hashId = "c".repeat(64);
    const record = { pid, hashId, ...(await seal(await key(), text.encode("hello"), `entries\u0000${pid}\u0000${id}`)) };
    const field = (name: string) => 1 + text.encode(name).length;
    const primaryKey = [pid, id];
    const expected =
      2 + 4 + text.encode(JSON.stringify(primaryKey)).length +
      field("pid") + 4 + text.encode(pid).length +
      field("hashId") + 4 + text.encode(hashId).length +
      field("v") + 1 +
      field("iv") + 4 + record.iv.length +
      field("bytes") + 4 + record.bytes.length +
      field("size") + 8;
    expect(record.bytes.length).toBe("hello".length + 16);
    expect(measureSealedRow(primaryKey, record)).toBe(expected);
    expect(measureSealedRow(primaryKey, { ...record, bytes: new Uint8Array(record.bytes.length + 1) })).toBe(expected + 1);
    expect(measureSealedRow([pid, `${id}f`], record)).toBeGreaterThan(expected);
    expect(measureSealedRow(primaryKey, { pid, v: 1, iv: record.iv, bytes: record.bytes })).toBeLessThan(expected);
  });

  test("counts every unsealed meta fence, status counter and field name", async () => {
    const pid = "d".repeat(64);
    const sealed = await seal(await key(), text.encode('{"grant":"private"}'), `meta\u0000${pid}`);
    const row = {
      pid, revision: 3, generation: 2, coverageCode: 2, syncedThroughEpoch: 7,
      keys: 1, contentMissing: 0, tombstones: 0, contentBytes: 17, purged: false,
      ...sealed, size: 0,
    };
    const field = (name: string) => 1 + text.encode(name).length;
    const numeric = ["revision", "generation", "syncedThroughEpoch", "keys", "contentMissing", "tombstones", "contentBytes", "size"];
    const expected =
      2 + 4 + text.encode(JSON.stringify(pid)).length +
      field("pid") + 4 + text.encode(pid).length +
      numeric.reduce((bytes, name) => bytes + field(name) + 8, 0) +
      field("coverageCode") + 1 + field("purged") + 1 +
      field("v") + 1 + field("iv") + 4 + row.iv.length +
      field("bytes") + 4 + row.bytes.length;
    expect(measureSealedRow(pid, row)).toBe(expected);
    expect(measureSealedRow(pid, { ...row, revision: 10_000, size: expected })).toBe(expected);
  });
});
