import { describe, expect, test } from "bun:test";

import { decodeBlob, decodeJson, encodeBlob, encodeJson } from "./codec.js";

describe("encrypted replica payload encoding", () => {
  test("round-trips a grant's binary UCAN without changing nested metadata", () => {
    const state = {
      config: { prefix: "notes/" },
      grant: { cid: "bafy-private", bytes: new Uint8Array([0, 127, 128, 255]) },
      metadata: { marker: "private", "__tinycloud_binary__": "true", hex: "not-a-binary-marker" },
    };
    const bytes = encodeJson(state);
    expect(decodeJson<typeof state>(bytes)).toEqual(state);
  });

  test("binds a blob's original hash inside the bytes encrypted under its opaque id", () => {
    const hash = "a".repeat(64);
    const content = new Uint8Array([0, 1, 127, 128, 255]);
    const encoded = encodeBlob(hash, content);
    expect(encoded.length).toBe(64 + content.length);
    expect(decodeBlob(encoded)).toEqual({ hash, bytes: content });
    expect(() => encodeBlob("not-a-hash", content)).toThrow();
    expect(() => decodeBlob(new Uint8Array(2))).toThrow();
  });

  test("rejects malformed serialized bytes instead of trusting a corrupt value", () => {
    expect(() => decodeJson(new TextEncoder().encode('{"grant":{"__tinycloud_binary__":true,"hex":"xyz"}}'))).toThrow();
    expect(() => decodeJson(new TextEncoder().encode("[bad json"))).toThrow();
  });
});
