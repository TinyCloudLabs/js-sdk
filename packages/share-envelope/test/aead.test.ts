import { describe, expect, it } from "vitest";

import {
  SEALED_BLOB_VERSION,
  decryptEnvelope,
  encryptEnvelope,
  generateKey,
  open,
  seal,
} from "../src/aead.js";
import { computeCid, verifyCid } from "../src/cid.js";
import { utf8Bytes } from "../src/bytes.js";

describe("AEAD envelope encryption", () => {
  it("round-trips encrypt → decrypt", async () => {
    const key = generateKey();
    const plaintext = utf8Bytes('{"version":1,"shareId":"s1"}');
    const { nonce, ciphertext } = await encryptEnvelope(plaintext, key);
    expect(nonce.length).toBe(12);
    const decrypted = await decryptEnvelope(nonce, ciphertext, key);
    expect(decrypted).toEqual(plaintext);
  });

  it("generates a fresh nonce per encrypt", async () => {
    const key = generateKey();
    const plaintext = utf8Bytes("same plaintext");
    const a = await encryptEnvelope(plaintext, key);
    const b = await encryptEnvelope(plaintext, key);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("generateKey returns 32 random bytes", () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.length).toBe(32);
    expect(a).not.toEqual(b);
  });

  it("fails to decrypt with the wrong key", async () => {
    const { nonce, ciphertext } = await encryptEnvelope(utf8Bytes("secret"), generateKey());
    await expect(decryptEnvelope(nonce, ciphertext, generateKey())).rejects.toThrow();
  });

  it("fails to decrypt tampered ciphertext (authenticated)", async () => {
    const key = generateKey();
    const { nonce, ciphertext } = await encryptEnvelope(utf8Bytes("secret"), key);
    const tampered = Uint8Array.from(ciphertext);
    tampered[0]! ^= 0x01;
    await expect(decryptEnvelope(nonce, tampered, key)).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes and nonces that are not 12 bytes", async () => {
    await expect(encryptEnvelope(utf8Bytes("x"), new Uint8Array(16))).rejects.toThrow(TypeError);
    const key = generateKey();
    const { ciphertext } = await encryptEnvelope(utf8Bytes("x"), key);
    await expect(decryptEnvelope(new Uint8Array(16), ciphertext, key)).rejects.toThrow(TypeError);
  });

});

describe("sealed blob (seal/open) — the canonical stored-block format", () => {
  it("seal → open round-trips using only the blob and the key", async () => {
    const key = generateKey();
    const plaintext = utf8Bytes('{"version":1,"shareId":"s1"}');
    const { blob, cid } = await seal(plaintext, key);
    // Format: version(1) || nonce(12) || ciphertext+tag(len+16).
    expect(blob[0]).toBe(SEALED_BLOB_VERSION);
    expect(blob.length).toBe(1 + 12 + plaintext.length + 16);
    // The CID addresses the WHOLE blob — the nonce is inside the CID-verified bytes.
    expect(cid).toBe(await computeCid(blob));
    expect(await verifyCid(blob, cid)).toBe(true);
    // Decryption needs nothing beyond blob + key (URL-recoverable material).
    expect(await open(blob, key)).toEqual(plaintext);
  });

  it("open rejects an unknown version byte", async () => {
    const key = generateKey();
    const { blob } = await seal(utf8Bytes("x"), key);
    const wrongVersion = Uint8Array.from(blob);
    wrongVersion[0] = 0x02;
    await expect(open(wrongVersion, key)).rejects.toThrow(TypeError);
  });

  it("open rejects truncated blobs", async () => {
    const key = generateKey();
    await expect(open(new Uint8Array(0), key)).rejects.toThrow(TypeError);
    await expect(open(new Uint8Array(1 + 12 + 15), key)).rejects.toThrow(TypeError);
  });

  it("open fails on tampering anywhere in the blob (nonce or ciphertext)", async () => {
    const key = generateKey();
    const { blob } = await seal(utf8Bytes("secret"), key);
    for (const index of [1, 5, blob.length - 1]) {
      const tampered = Uint8Array.from(blob);
      tampered[index]! ^= 0x01;
      await expect(open(tampered, key)).rejects.toThrow();
    }
  });

  it("open fails with the wrong key", async () => {
    const { blob } = await seal(utf8Bytes("secret"), generateKey());
    await expect(open(blob, generateKey())).rejects.toThrow();
  });

  it("tampered blob also fails the CID check (interop-vector spirit, §10.2)", async () => {
    const key = generateKey();
    const { blob, cid } = await seal(utf8Bytes("envelope body"), key);
    const tampered = Uint8Array.from(blob);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(await verifyCid(tampered, cid)).toBe(false);
    expect(await verifyCid(blob, cid)).toBe(true);
  });
});
