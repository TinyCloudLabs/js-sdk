import { describe, it, expect } from "bun:test";
import {
  validateAuthorizationResultV1,
  isPlausibleOpenKeyActionId,
  extractImmutableSiweFields,
  diffImmutableSiweFields,
  extractRecapAttenuations,
  unauthorizedRecapCapabilities,
  parseCanonicalRecapResource,
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
    // Sol MAJOR-4: extended immutable-field coverage.
    expect(fields.expirationTime).toBe("2026-08-01T01:00:00.000Z");
    // The statement is the single line "By signing..." between the
    // address blank line and the "URI:" line.
    expect(fields.statement).toBe(
      "By signing this message you agree to the terms.",
    );
    // No non-recap resources in the fixture.
    expect(fields.nonRecapResources).toBe("");
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

  it("flags expirationTime drift (Sol MAJOR-4)", () => {
    const original = extractImmutableSiweFields(SAMPLE_SIWE);
    const changed = extractImmutableSiweFields(
      SAMPLE_SIWE.replace(
        "Expiration Time: 2026-08-01T01:00:00.000Z",
        "Expiration Time: 2027-01-01T00:00:00.000Z",
      ),
    );
    expect(diffImmutableSiweFields(original, changed)).toContain("expirationTime");
  });

  it("flags statement drift (Sol MAJOR-4)", () => {
    const original = extractImmutableSiweFields(SAMPLE_SIWE);
    const changed = extractImmutableSiweFields(
      SAMPLE_SIWE.replace(
        "By signing this message you agree to the terms.",
        "You are transferring your entire wallet.",
      ),
    );
    expect(diffImmutableSiweFields(original, changed)).toContain("statement");
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

  describe("caveat subsetting", () => {
    it("rejects when child drops all caveats (parent has restrictions)", () => {
      const parent = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ maxSize: 1000 }],
        },
      };
      const child = {
        "space/kv/data": {
          "tinycloud.kv/put": [],
        },
      };
      expect(unauthorizedRecapCapabilities(child, parent)).toEqual([
        { resource: "space/kv/data", action: "tinycloud.kv/put" },
      ]);
    });

    it("rejects when child replaces a restrictive caveat with a different one (broadening)", () => {
      const parent = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ maxSize: 1000 }],
        },
      };
      const child = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ maxSize: 999999 }],
        },
      };
      expect(unauthorizedRecapCapabilities(child, parent)).toEqual([
        { resource: "space/kv/data", action: "tinycloud.kv/put" },
      ]);
    });

    it("rejects when child adds a caveat alternative not in parent (incompatible duplicate)", () => {
      const parent = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ path: "a" }],
        },
      };
      const child = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ path: "a" }, { path: "b" }],
        },
      };
      expect(unauthorizedRecapCapabilities(child, parent)).toEqual([
        { resource: "space/kv/data", action: "tinycloud.kv/put" },
      ]);
    });

    it("REJECTS when child selects a strict subset of parent's caveat alternatives (Sol MAJOR-6 strict equality)", () => {
      // Sol MAJOR-6: without a formal attenuation-proof mechanism, we
      // treat any divergence — including dropping an alternative from
      // a disjunction — as a mismatch. Subsetting used to be accepted;
      // the strict-equality rule now rejects it because we cannot
      // prove that the transformation was intentional.
      const parent = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ path: "a" }, { path: "b" }, { path: "c" }],
        },
      };
      const child = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ path: "a" }],
        },
      };
      expect(unauthorizedRecapCapabilities(child, parent)).toEqual([
        { resource: "space/kv/data", action: "tinycloud.kv/put" },
      ]);
    });

    it("REJECTS when parent has no caveats but child adds one (Sol MAJOR-6 strict equality)", () => {
      // Sol MAJOR-6: any divergence in the multiset of caveats is a
      // mismatch, including adding restrictions to an unrestricted
      // parent. Formal attenuation may later relax this.
      const parent = {
        "space/kv/data": {
          "tinycloud.kv/put": [],
        },
      };
      const child = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ maxSize: 500 }],
        },
      };
      expect(unauthorizedRecapCapabilities(child, parent)).toEqual([
        { resource: "space/kv/data", action: "tinycloud.kv/put" },
      ]);
    });

    it("accepts identical caveat multisets (order-independent)", () => {
      // Order within a caveat list should not matter; the canonical
      // multiset comparison treats [{a:1},{b:2}] equal to [{b:2},{a:1}].
      const parent = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ a: 1 }, { b: 2 }],
        },
      };
      const child = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ b: 2 }, { a: 1 }],
        },
      };
      expect(unauthorizedRecapCapabilities(child, parent)).toEqual([]);
    });

    it("accepts caveats that differ only in key insertion order", () => {
      const parent = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ a: 1, b: 2 }],
        },
      };
      const child = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ b: 2, a: 1 }],
        },
      };
      expect(unauthorizedRecapCapabilities(child, parent)).toEqual([]);
    });

    it("rejects nested caveat structural changes", () => {
      const parent = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ nested: { limit: 10 } }],
        },
      };
      const child = {
        "space/kv/data": {
          "tinycloud.kv/put": [{ nested: { limit: 100 } }],
        },
      };
      expect(unauthorizedRecapCapabilities(child, parent)).toEqual([
        { resource: "space/kv/data", action: "tinycloud.kv/put" },
      ]);
    });
  });
});

// Sol final continuation contract requirement 1: canonical ReCap resource
// parser must match the WASM `parseRecapFromSiwe` semantic — the middle
// `<short-service>` segment is NEVER part of `path`. Every producer AND
// consumer of canonical four-part action IDs walks through this helper.
describe("parseCanonicalRecapResource (Sol continuation req 1)", () => {
  const space = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";

  it("returns { space, path: '' } for a whole-space grant `<space>/<short>`", () => {
    // WASM: `abilities: { kv: { "": [...] } }` produces URI `<space>/kv`
    // and `parseRecapFromSiwe` reports `path=""`.
    expect(parseCanonicalRecapResource(`${space}/kv`)).toEqual({
      space,
      path: "",
    });
  });

  it("strips the service segment from `<space>/<short>/<sub-path>`", () => {
    // WASM: `abilities: { kv: { "listen/transcript": [...] } }` produces
    // URI `<space>/kv/listen/transcript` and reports `path="listen/transcript"`.
    expect(
      parseCanonicalRecapResource(`${space}/kv/listen/transcript`),
    ).toEqual({ space, path: "listen/transcript" });
  });

  it("keeps a repeated-space path (`<space>/<short>/<space>`) verbatim", () => {
    // WASM: `abilities: { kv: { [spaceId]: [...] } }` produces
    // URI `<space>/kv/<space>` and reports `path=<space>`.
    expect(parseCanonicalRecapResource(`${space}/kv/${space}`)).toEqual({
      space,
      path: space,
    });
  });

  it("returns non-tinycloud URIs unchanged as space (path empty)", () => {
    const encryptionUri =
      "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
    expect(parseCanonicalRecapResource(encryptionUri)).toEqual({
      space: encryptionUri,
      path: "",
    });
  });

  it("returns `<space>` unchanged when no `/` is present after the tinycloud: prefix", () => {
    // Rare — a bare space URI without any ability grants a zero-ability
    // resource. Parser must not throw.
    expect(parseCanonicalRecapResource(space)).toEqual({ space, path: "" });
  });

  it("mirrors WASM `parseRecapFromSiwe`: path equals what WASM's entry.path would be", () => {
    // This is the load-bearing invariant: for every real production URI
    // shape, the canonical parser's `path` equals what the WASM SDK
    // returns from `parseRecapFromSiwe`. Concrete cases we've verified
    // against a real WASM build:
    const cases: Array<{ uri: string; wasmPath: string }> = [
      { uri: `${space}/kv`, wasmPath: "" },
      { uri: `${space}/kv/listen/transcript`, wasmPath: "listen/transcript" },
      { uri: `${space}/kv/${space}`, wasmPath: space },
      { uri: `${space}/capabilities/${space}`, wasmPath: space },
    ];
    for (const { uri, wasmPath } of cases) {
      const { space: parsedSpace, path } = parseCanonicalRecapResource(uri);
      expect(parsedSpace).toBe(space);
      expect(path).toBe(wasmPath);
    }
  });
});
