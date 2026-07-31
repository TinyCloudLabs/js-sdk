import { describe, it, expect } from "bun:test";
import {
  validateAuthorizationResultV1,
  isPlausibleOpenKeyActionId,
  extractImmutableSiweFields,
  diffImmutableSiweFields,
  extractRecapAttenuations,
  unauthorizedRecapCapabilities,
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

const SAMPLE_SIWE = [
  "example.com wants you to sign in with your Ethereum account:",
  "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  "",
  "By signing this message you agree to the terms.",
  "",
  "URI: did:key:z6Mkexample",
  "Version: 1",
  "Chain ID: 1",
  "Nonce: abcdef01",
  "Issued At: 2026-08-01T00:00:00.000Z",
  "Expiration Time: 2026-08-01T01:00:00.000Z",
  "Resources:",
  // ReCap payload: att = { "tinycloud:foo/kv/data": { "tinycloud.kv/get": [{}] } }
  "- urn:recap:eyJhdHQiOnsidGlueWNsb3VkOmZvby9rdi9kYXRhIjp7InRpbnljbG91ZC5rdi9nZXQiOlt7fV19fSwicHJmIjpbXX0",
].join("\n");

describe("extractImmutableSiweFields", () => {
  it("extracts every header field the SDK cares about", () => {
    const fields = extractImmutableSiweFields(SAMPLE_SIWE);
    expect(fields.domain).toBe("example.com");
    expect(fields.address).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(fields.uri).toBe("did:key:z6Mkexample");
    expect(fields.version).toBe("1");
    expect(fields.chainId).toBe("1");
    expect(fields.nonce).toBe("abcdef01");
    expect(fields.issuedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("diffImmutableSiweFields", () => {
  it("returns an empty array when the messages agree", () => {
    const a = extractImmutableSiweFields(SAMPLE_SIWE);
    const b = extractImmutableSiweFields(SAMPLE_SIWE);
    expect(diffImmutableSiweFields(a, b)).toEqual([]);
  });

  it("flags the specific field that differs", () => {
    const original = extractImmutableSiweFields(SAMPLE_SIWE);
    const changed = extractImmutableSiweFields(
      SAMPLE_SIWE.replace("Nonce: abcdef01", "Nonce: 00000000"),
    );
    expect(diffImmutableSiweFields(original, changed)).toEqual(["nonce"]);
  });

  it("flags domain drift", () => {
    const original = extractImmutableSiweFields(SAMPLE_SIWE);
    const changed = extractImmutableSiweFields(
      SAMPLE_SIWE.replace("example.com", "attacker.example"),
    );
    expect(diffImmutableSiweFields(original, changed)).toEqual(["domain"]);
  });
});

describe("extractRecapAttenuations", () => {
  it("decodes a urn:recap: block into a resource -> action map", () => {
    const caps = extractRecapAttenuations(SAMPLE_SIWE);
    expect(Object.keys(caps)).toContain("tinycloud:foo/kv/data");
    expect(caps["tinycloud:foo/kv/data"]["tinycloud.kv/get"]).toEqual([{}]);
  });

  it("returns an empty map for a SIWE with no recap resources", () => {
    const noRecap = SAMPLE_SIWE.replace(/^Resources:[\s\S]*$/m, "");
    expect(extractRecapAttenuations(noRecap)).toEqual({});
  });

  it("throws when a recap payload is not valid base64/JSON", () => {
    const broken = SAMPLE_SIWE.replace(
      /urn:recap:[A-Za-z0-9_-]+=*/,
      "urn:recap:!!!not-base64!!!",
    );
    // The regex we match against only accepts base64url so a truly-garbage
    // payload just gets ignored; but a base64-looking but non-JSON one
    // triggers the parse error.
    const garbageJson = SAMPLE_SIWE.replace(
      /urn:recap:[A-Za-z0-9_-]+=*/,
      "urn:recap:aGVsbG8", // "hello" — not JSON
    );
    expect(() => extractRecapAttenuations(broken)).not.toThrow();
    expect(() => extractRecapAttenuations(garbageJson)).toThrow(
      /not valid JSON/,
    );
  });
});

describe("unauthorizedRecapCapabilities", () => {
  it("returns an empty array when child is a strict subset", () => {
    const parent = {
      "space/kv/data": {
        "tinycloud.kv/get": [{}],
        "tinycloud.kv/put": [{}],
      },
    };
    const child = {
      "space/kv/data": {
        "tinycloud.kv/get": [{}],
      },
    };
    expect(unauthorizedRecapCapabilities(child, parent)).toEqual([]);
  });

  it("flags actions the child grants but the parent does not", () => {
    const parent = {
      "space/kv/data": {
        "tinycloud.kv/get": [{}],
      },
    };
    const child = {
      "space/kv/data": {
        "tinycloud.kv/get": [{}],
        "tinycloud.kv/put": [{}],
      },
    };
    expect(unauthorizedRecapCapabilities(child, parent)).toEqual([
      { resource: "space/kv/data", action: "tinycloud.kv/put" },
    ]);
  });

  it("flags resources the child grants but the parent does not", () => {
    const parent = {
      "space/kv/data": { "tinycloud.kv/get": [{}] },
    };
    const child = {
      "space/other/path": { "tinycloud.kv/get": [{}] },
    };
    expect(unauthorizedRecapCapabilities(child, parent)).toEqual([
      { resource: "space/other/path", action: "tinycloud.kv/get" },
    ]);
  });
});
