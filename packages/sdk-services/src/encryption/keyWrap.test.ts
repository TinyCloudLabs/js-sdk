import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519";
import { gcm } from "@noble/ciphers/aes";
import { base64Decode, canonicalize, utf8Encode } from "./canonical";
import { openKeyV2, readKeyWrapV2, sealKeyV2, type KeyWrapContext } from "./keyWrap";
import fixture from "./fixtures/key-wrap-v2.json";

const secret = new Uint8Array(32).fill(7);
const publicKey = x25519.getPublicKey(secret);
const plaintext = new Uint8Array(32).fill(42);
const context: KeyWrapContext = {
  purpose: "network-key", networkId: "", keyPath: "share/test", keyVersion: 1,
  metadata: { contentType: "text/plain" },
};

function replaceHeader(wrapped: Uint8Array, change: (h: Record<string, unknown>) => void): Uint8Array {
  const length = new DataView(wrapped.buffer, wrapped.byteOffset).getUint32(4);
  const header = JSON.parse(new TextDecoder().decode(wrapped.subarray(8, 8 + length)));
  change(header);
  const bytes = utf8Encode(canonicalize(header));
  const out = new Uint8Array(8 + bytes.length + wrapped.length - 8 - length);
  out.set(wrapped.subarray(0, 4));
  new DataView(out.buffer).setUint32(4, bytes.length);
  out.set(bytes, 8);
  out.set(wrapped.subarray(8 + length), 8 + bytes.length);
  return out;
}

describe("key wrap interoperability", () => {
  for (const vector of fixture.vectors) {
    test(`opens shared ${vector.name}`, () => {
      const wrapped = base64Decode(vector.wrappedKey);
      const privateKey = base64Decode(vector.recipientPrivateKey);
      const opened = vector.version === 2
        ? openKeyV2(privateKey, wrapped, { ...vector.context, purpose: vector.purpose as KeyWrapContext["purpose"] })
        : gcm(x25519.getSharedSecret(privateKey, wrapped.subarray(0, 32)), wrapped.subarray(33, 45)).decrypt(wrapped.subarray(45));
      if (vector.version === 1) expect(wrapped[32]).toBe(1);
      expect(opened).toEqual(base64Decode(vector.plaintext));
    });
  }

  test("round trips root and named contexts with fresh salt and nonce", () => {
    for (const keyPath of ["", "share/test"]) {
      const expected = { ...context, keyPath };
      const first = sealKeyV2(publicKey, plaintext, expected);
      const second = sealKeyV2(publicKey, plaintext, expected);
      expect(openKeyV2(secret, first, expected)).toEqual(plaintext);
      expect(first).not.toEqual(second);
      expect(readKeyWrapV2(first).header.salt).not.toBe(readKeyWrapV2(second).header.salt);
    }
  });

  test("checks every expected context and actual recipient", () => {
    const wrapped = sealKeyV2(publicKey, plaintext, context);
    for (const changed of [
      { purpose: "receiver-key" as const }, { networkId: "other" }, { keyPath: "share/other" },
      { keyVersion: 2 }, { metadata: {} },
    ]) expect(() => openKeyV2(secret, wrapped, { ...context, ...changed })).toThrow();
    expect(() => openKeyV2(new Uint8Array(32).fill(8), wrapped, context)).toThrow();
  });

  test("authenticates header, salt, public keys, and ciphertext", () => {
    const wrapped = sealKeyV2(publicKey, plaintext, context);
    for (const field of ["salt", "ephemeralPublicKey", "recipientPublicKey"]) {
      const changed = replaceHeader(wrapped, h => { h[field] = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg="; });
      expect(() => openKeyV2(secret, changed, context)).toThrow();
    }
    const changed = wrapped.slice();
    changed[changed.length - 1] ^= 1;
    expect(() => openKeyV2(secret, changed, context)).toThrow();
  });

  test("rejects non-contributory recipients and malformed closed headers", () => {
    expect(() => sealKeyV2(new Uint8Array(32), plaintext, context)).toThrow();
    const wrapped = sealKeyV2(publicKey, plaintext, context);
    for (const change of [
      (h: Record<string, unknown>) => { h.extra = 1; },
      (h: Record<string, unknown>) => { delete h.salt; },
      (h: Record<string, unknown>) => { h.v = 1; },
      (h: Record<string, unknown>) => { h.keyVersion = 0; },
      (h: Record<string, unknown>) => { h.metadata = { bad: 1 }; },
      (h: Record<string, unknown>) => { h.aead = "other"; },
    ]) expect(() => readKeyWrapV2(replaceHeader(wrapped, change))).toThrow();
    for (const length of [0, 4, 7, 8, wrapped.length - 17]) {
      expect(() => openKeyV2(secret, wrapped.subarray(0, length), context)).toThrow();
    }
    const huge = wrapped.slice();
    new DataView(huge.buffer).setUint32(4, 65537);
    expect(() => readKeyWrapV2(huge)).toThrow();
  });
});

test("requires canonical header bytes rather than equivalent JSON", () => {
  const wrapped = sealKeyV2(publicKey, plaintext, context);
  const parsed = readKeyWrapV2(wrapped);
  const bytes = utf8Encode(JSON.stringify(parsed.header, null, 2));
  const out = new Uint8Array(8 + bytes.length + 12 + parsed.ciphertext.length);
  out.set(wrapped.subarray(0, 4)); new DataView(out.buffer).setUint32(4, bytes.length);
  out.set(bytes, 8); out.set(parsed.nonce, 8 + bytes.length); out.set(parsed.ciphertext, 20 + bytes.length);
  expect(() => readKeyWrapV2(out)).toThrow();
});

for (const invalid of ["\ud800", "\udc00"]) {
  for (const field of ["keyPath", "metadataKey", "metadataValue"] as const) {
    test(`rejects lone surrogate ${invalid.charCodeAt(0).toString(16)} in ${field}`, () => {
      const changed = { ...context, metadata: { ...context.metadata } };
      if (field === "keyPath") changed.keyPath = invalid;
      else changed.metadata = field === "metadataKey" ? { [invalid]: "value" } : { key: invalid };
      expect(() => sealKeyV2(publicKey, plaintext, changed)).toThrow();
      const wrapped = sealKeyV2(publicKey, plaintext, context);
      expect(() => readKeyWrapV2(replaceHeader(wrapped, h => {
        h.keyPath = changed.keyPath;
        h.metadata = changed.metadata;
      }))).toThrow();
    });
  }
}

test("preserves paired Unicode and distinct replacement characters exactly", () => {
  const unicode = { ...context, keyPath: "share/😀", metadata: { "😀": "é e\u0301 😀 \ufffd" } };
  const wrapped = sealKeyV2(publicKey, plaintext, unicode);
  expect(readKeyWrapV2(wrapped).header).toMatchObject(unicode);
  expect(openKeyV2(secret, wrapped, unicode)).toEqual(plaintext);
  expect(() => openKeyV2(secret, wrapped, { ...unicode, metadata: { "😀": "é é 😀 \ufffd" } })).toThrow();
});
