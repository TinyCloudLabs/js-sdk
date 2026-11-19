import { afterEach, expect, spyOn, test } from "bun:test";
// The browser build's replacement for @noble/hashes/crypto (webpack.config.cjs): every noble randomBytes call in the
// web SDK (keys, nonces) draws from it.
import { crypto as nobleCrypto } from "../src/polyfills/noble-crypto-browser.mjs";

const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
afterEach(() => Object.defineProperty(globalThis, "crypto", original));

test("random bytes come from the browser's crypto.getRandomValues", () => {
  const getRandomValues = spyOn(globalThis.crypto, "getRandomValues");
  try {
    const array = new Uint8Array(32);
    expect(nobleCrypto.getRandomValues(array)).toBe(array);
    expect(getRandomValues).toHaveBeenCalledWith(array);
  } finally {
    getRandomValues.mockRestore();
  }
});

test("without crypto.getRandomValues it refuses instead of using another source", () => {
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  const array = new Uint8Array(32);
  expect(() => nobleCrypto.getRandomValues(array)).toThrow("crypto.getRandomValues is unavailable");
  expect(array.every((byte) => byte === 0)).toBe(true);
});
