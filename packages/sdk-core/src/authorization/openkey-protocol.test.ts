import { describe, it, expect } from "bun:test";
import {
  validateAuthorizationResultV1,
  isPlausibleOpenKeyActionId,
} from "./openkey-protocol";

describe("validateAuthorizationResultV1", () => {
  const valid = {
    protocolVersion: 1,
    address: "0x1111111111111111111111111111111111111111",
    signature: "0x00",
    signedMessage: "example.com wants you to sign in with your Ethereum account:\n...",
    selectedActionKeys: ["a1", "a2"],
    permissions: [
      {
        service: "tinycloud.kv",
        space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default",
        path: "",
        actions: ["tinycloud.kv/get"],
      },
    ],
  };

  it("accepts a well-formed payload", () => {
    const res = validateAuthorizationResultV1(valid);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.protocolVersion).toBe(1);
      expect(res.value.permissions).toHaveLength(1);
    }
  });

  it("rejects unsupported protocol versions", () => {
    const res = validateAuthorizationResultV1({ ...valid, protocolVersion: 2 });
    expect(res.ok).toBe(false);
  });

  it("rejects missing signedMessage", () => {
    const { signedMessage: _drop, ...rest } = valid;
    const res = validateAuthorizationResultV1(rest);
    expect(res.ok).toBe(false);
  });

  it("rejects non-string action IDs", () => {
    const res = validateAuthorizationResultV1({
      ...valid,
      selectedActionKeys: [1, 2],
    });
    expect(res.ok).toBe(false);
  });

  it("rejects malformed permissions entries", () => {
    const res = validateAuthorizationResultV1({
      ...valid,
      permissions: [{ service: "kv" }],
    });
    expect(res.ok).toBe(false);
  });

  it("accepts plausible action IDs", () => {
    // Four NUL-separated fields
    expect(isPlausibleOpenKeyActionId("kv\0space\0path\0action")).toBe(true);
    expect(isPlausibleOpenKeyActionId("not-nul-separated")).toBe(false);
    expect(isPlausibleOpenKeyActionId(42)).toBe(false);
  });
});
