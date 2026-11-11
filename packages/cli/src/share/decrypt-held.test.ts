import { describe, expect, it } from "bun:test";
import { sessionHoldsEncryptionDecrypt } from "./adapters.js";

const network = "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
const key = `${network}/share/${"a1".repeat(16)}`;
const DECRYPT = "tinycloud.encryption/decrypt";
const named = () => { throw new Error("Manifest validation failed: named keys go in manifest.keys"); };
const grant = (path: string, overrides: { expiry?: Date; actions?: string[]; service?: string } = {}) => ({
  expiry: overrides.expiry ?? new Date(Date.now() + 3_600_000),
  resources: [{ service: overrides.service ?? "encryption", space: "encryption", path, actions: overrides.actions ?? [DECRYPT, "tinycloud.encryption/key.create"] }],
});
const node = (delegations: unknown[], has: () => boolean = named) => ({ hasRuntimePermissions: has, getRuntimePermissionDelegations: () => delegations }) as never;

describe("sessionHoldsEncryptionDecrypt: the named-key fallback", () => {
  it("is the SDK's answer whenever the SDK can answer", () => {
    expect(sessionHoldsEncryptionDecrypt(node([], () => true), key)).toBe(true);
    expect(sessionHoldsEncryptionDecrypt(node([grant(key)], () => false), key)).toBe(false);
  });

  it("on the named-key validation error, holds decrypt only through a live runtime grant for exactly that key", () => {
    expect(sessionHoldsEncryptionDecrypt(node([grant(key)]), key)).toBe(true);
    expect(sessionHoldsEncryptionDecrypt(node([]), key)).toBe(false);
  });

  it("refuses an expired grant, a sibling key, the network or a prefix, another action, and another service", () => {
    expect(sessionHoldsEncryptionDecrypt(node([grant(key, { expiry: new Date(Date.now() - 1000) })]), key)).toBe(false);
    expect(sessionHoldsEncryptionDecrypt(node([grant(`${network}/share/${"b2".repeat(16)}`)]), key)).toBe(false);
    expect(sessionHoldsEncryptionDecrypt(node([grant(network)]), key)).toBe(false);
    expect(sessionHoldsEncryptionDecrypt(node([grant(`${network}/share/`)]), key)).toBe(false);
    expect(sessionHoldsEncryptionDecrypt(node([grant(key, { actions: ["tinycloud.encryption/key.create"] })]), key)).toBe(false);
    expect(sessionHoldsEncryptionDecrypt(node([grant(key, { service: "kv" })]), key)).toBe(false);
  });

  it("rethrows any other error, and the named-key error when no runtime grants can be listed", () => {
    const other = new Error("something else failed");
    expect(() => sessionHoldsEncryptionDecrypt(node([grant(key)], () => { throw other; }), key)).toThrow(other);
    expect(() => sessionHoldsEncryptionDecrypt({ hasRuntimePermissions: named } as never, key)).toThrow(/named keys go in manifest\.keys/);
  });
});
