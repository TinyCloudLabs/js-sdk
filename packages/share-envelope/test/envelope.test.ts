import { describe, expect, it } from "vitest";

import { getBearerSessionJwk } from "../src/bearer.js";
import { didKeyFromEd25519PublicKey, ed25519PublicKeyFromDidKey } from "../src/didkey.js";
import {
  isCanonicalHttpsOrigin,
  shareEnvelopeSchema,
  unsignedShareEnvelopeSchema,
} from "../src/schema.js";
import { signEnvelope, verifyEnvelope, verifyEnvelopeSignatureOnly } from "../src/sign.js";
import {
  BEARER_TARGET,
  RECIPIENT_DID_TARGET,
  TEST_PRIV_KEY,
  TEST_PUB_KEY,
  makeUnsignedEnvelope,
} from "./fixtures.js";

/** The DID the recipient side is told, out-of-band, to expect as sender. */
const SENDER_DID = didKeyFromEd25519PublicKey(TEST_PUB_KEY);

describe("did:key (ed25519, multicodec 0xed)", () => {
  it("round-trips encode → decode", () => {
    const did = didKeyFromEd25519PublicKey(TEST_PUB_KEY);
    expect(did.startsWith("did:key:z6Mk")).toBe(true); // 0xed01 prefix signature
    expect(ed25519PublicKeyFromDidKey(did)).toEqual(TEST_PUB_KEY);
  });

  it("matches the W3C did:key ed25519 test vector", () => {
    // https://w3c-ccg.github.io/did-method-key/ example key
    const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    const pub = ed25519PublicKeyFromDidKey(did);
    expect(pub.length).toBe(32);
    expect(didKeyFromEd25519PublicKey(pub)).toBe(did);
  });

  it("rejects non-ed25519 and non-did:key inputs", () => {
    expect(() => ed25519PublicKeyFromDidKey("did:web:example.com")).toThrow(TypeError);
    // secp256k1 did:key (multicodec 0xe7) must be rejected
    expect(() =>
      ed25519PublicKeyFromDidKey("did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme"),
    ).toThrow(TypeError);
    expect(() => didKeyFromEd25519PublicKey(new Uint8Array(31))).toThrow(TypeError);
  });
});

describe("sign/verify", () => {
  it("sign → verify happy path (trust bound to the expected signer)", async () => {
    const signed = signEnvelope(makeUnsignedEnvelope(), TEST_PRIV_KEY);
    expect(signed.signature.signerDid).toBe(SENDER_DID);
    expect(signed.signature.algorithm).toBe("Ed25519");
    expect(await verifyEnvelope(signed, { expectedSignerDid: SENDER_DID })).toBe(true);
  });

  it("trust binding: attacker re-signs altered metadata with a NEW key and fails", async () => {
    // The attacker takes the real envelope, alters signed metadata (posing as
    // "Adam" toward a different origin), and re-signs with their OWN key.
    const attackerKey = new Uint8Array(32).fill(0x42);
    const forged = signEnvelope(
      makeUnsignedEnvelope({
        display: { senderName: "Adam", filename: "report.md", recipientHint: "b***@gmail.com" },
        shareId: "share-evil",
      }),
      attackerKey,
    );
    // The forgery is internally consistent — signature-only verification passes…
    expect(verifyEnvelopeSignatureOnly(forged)).toBe(true);
    // …which is exactly why the exported verify REQUIRES the expected sender
    // DID and rejects the self-asserted signer.
    expect(await verifyEnvelope(forged, { expectedSignerDid: SENDER_DID })).toBe(false);
  });

  it("policy targets: policyBytes must hash to policyCid", async () => {
    const good = signEnvelope(makeUnsignedEnvelope(), TEST_PRIV_KEY);
    expect(await verifyEnvelope(good, { expectedSignerDid: SENDER_DID })).toBe(true);
    // Same shape, but the (signed) policyBytes do not match the (signed)
    // policyCid — verification must fail even though the signature is valid.
    const mismatched = signEnvelope(
      makeUnsignedEnvelope({
        authorizationTarget: {
          kind: "policy",
          policyCid: good.authorizationTarget.kind === "policy" ? good.authorizationTarget.policyCid : "",
          policyBytes: "eyJwb2xpY3kiOiJvdGhlciJ9", // {"policy":"other"}
        },
      }),
      TEST_PRIV_KEY,
    );
    expect(await verifyEnvelope(mismatched, { expectedSignerDid: SENDER_DID })).toBe(false);
  });

  it("signature is independent of body key order (JCS)", () => {
    const unsigned = makeUnsignedEnvelope();
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([k, v]) => [k, reverseKeys(v)]),
        );
      }
      return value;
    };
    const reordered = reverseKeys(unsigned) as typeof unsigned;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(unsigned));
    const a = signEnvelope(unsigned, TEST_PRIV_KEY);
    const b = signEnvelope(reordered, TEST_PRIV_KEY);
    expect(a.signature.value).toBe(b.signature.value);
  });

  it("detects tampering with any signed field", async () => {
    const signed = signEnvelope(makeUnsignedEnvelope(), TEST_PRIV_KEY);
    const expected = { expectedSignerDid: SENDER_DID };
    expect(
      await verifyEnvelope({ ...signed, shareId: "share-999" }, expected),
    ).toBe(false);
    // Re-framing the target origin (the §2.1 exfiltration hole) is caught.
    expect(
      await verifyEnvelope(
        { ...signed, target: { ...signed.target, origin: "https://evil.example.com" } },
        expected,
      ),
    ).toBe(false);
    // Re-framing a policy share as a bearer share is caught (signed union kind).
    expect(
      await verifyEnvelope({ ...signed, authorizationTarget: BEARER_TARGET }, expected),
    ).toBe(false);
  });

  it("rejects a signature from a different signer", async () => {
    const signed = signEnvelope(makeUnsignedEnvelope(), TEST_PRIV_KEY);
    const otherKey = new Uint8Array(32).fill(9);
    const other = signEnvelope(makeUnsignedEnvelope(), otherKey);
    // Right signature bytes, wrong claimed signer DID:
    expect(
      await verifyEnvelope(
        { ...signed, signature: { ...signed.signature, signerDid: other.signature.signerDid } },
        { expectedSignerDid: other.signature.signerDid },
      ),
    ).toBe(false);
  });

  it("throws on schema-invalid envelopes rather than verifying them", async () => {
    const signed = signEnvelope(makeUnsignedEnvelope(), TEST_PRIV_KEY);
    const withExtra = { ...signed, extra: true } as unknown as typeof signed;
    await expect(
      verifyEnvelope(withExtra, { expectedSignerDid: SENDER_DID }),
    ).rejects.toThrow();
    expect(() => verifyEnvelopeSignatureOnly(withExtra)).toThrow();
  });
});

describe("envelope schema (strict zod)", () => {
  it("accepts all three authorizationTarget variants", () => {
    for (const target of [
      makeUnsignedEnvelope().authorizationTarget,
      BEARER_TARGET,
      RECIPIENT_DID_TARGET,
    ]) {
      const parsed = unsignedShareEnvelopeSchema.safeParse(
        makeUnsignedEnvelope({ authorizationTarget: target }),
      );
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects unknown fields at every level", () => {
    const base = makeUnsignedEnvelope();
    const cases: unknown[] = [
      { ...base, unknownField: 1 },
      { ...base, target: { ...base.target, extra: true } },
      { ...base, display: { ...base.display, extra: "x" } },
      {
        ...base,
        target: { ...base.target, resource: { kind: "exact", path: "p", extra: 1 } },
      },
      {
        ...base,
        authorizationTarget: { ...base.authorizationTarget, extra: 1 },
      },
    ];
    for (const value of cases) {
      expect(unsignedShareEnvelopeSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects each malformed authorizationTarget variant", () => {
    const okp = BEARER_TARGET.kind === "bearerKey" ? BEARER_TARGET.sessionJwk : ({} as never);
    const malformed: unknown[] = [
      { kind: "policy", policyCid: "bafk..." }, // missing policyBytes
      { kind: "policy", policyCid: "bafk...", policyBytes: "not base64url!!" },
      { kind: "policy", policyCid: "bafk...", policyBytes: "ab==" }, // padded, not strictly decodable
      { kind: "policy", policyCid: "bafk...", policyBytes: "Zh" }, // non-zero trailing bits
      { kind: "bearerKey" }, // missing sessionJwk
      { kind: "bearerKey", sessionJwk: { crv: "Ed25519" } }, // missing kty
      { kind: "bearerKey", sessionJwk: { kty: "OKP", bogus: "field" } },
      { kind: "bearerKey", sessionJwk: { kty: "OKP", crv: "Ed25519", x: okp.x } }, // public-only: d required
      { kind: "bearerKey", sessionJwk: { ...okp, y: "AQAB" } }, // cross-family: y on OKP
      { kind: "bearerKey", sessionJwk: { ...okp, k: "c2VjcmV0" } }, // cross-family: oct k
      { kind: "bearerKey", sessionJwk: { kty: "oct", k: "c2VjcmV0" } }, // symmetric keys not allowed
      { kind: "bearerKey", sessionJwk: { kty: "EC", crv: "P-256", x: "AQAB", d: "AQAB" } }, // EC needs y
      { kind: "bearerKey", sessionJwk: { ...okp, d: "not base64url!!" } }, // undecodable component
      { kind: "recipientDid", did: "not-a-did" },
      { kind: "recipientDid" }, // missing did
      { kind: "somethingElse", did: "did:key:z6Mk..." }, // unknown discriminant
    ];
    for (const authorizationTarget of malformed) {
      const result = unsignedShareEnvelopeSchema.safeParse(
        makeUnsignedEnvelope({
          authorizationTarget: authorizationTarget as never,
        }),
      );
      expect(result.success).toBe(false);
    }
  });

  it("rejects bad resource selectors, versions, and expiries", () => {
    const base = makeUnsignedEnvelope();
    const cases: unknown[] = [
      { ...base, version: 2 },
      { ...base, expiry: "tomorrow" },
      { ...base, target: { ...base.target, resource: { kind: "glob", path: "*" } } },
      { ...base, target: { ...base.target, origin: "not a url" } },
    ];
    for (const value of cases) {
      expect(unsignedShareEnvelopeSchema.safeParse(value).success).toBe(false);
    }
  });

  it("enforces the canonical resource-path grammar at schema level (fail closed)", () => {
    const base = makeUnsignedEnvelope();
    const withPath = (kind: "exact" | "prefix", path: string): unknown => ({
      ...base,
      target: { ...base.target, resource: { kind, path } },
    });
    // traversal aliases, empty segments, encoded separators, backslash,
    // control chars: rejected before any signing or comparison can happen
    const hostilePaths = [
      "shares/share-1/../victim.md",
      "../victim.md",
      "shares//share-1/f.md",
      "/shares/share-1/f.md",
      "shares/share-1/",
      "shares/./f.md",
      "shares/share-1/f%2e%2e.md",
      "shares/share-1%2fescape.md",
      "shares/share-1%5c.md",
      "shares\\share-1\\f.md",
      "shares/share-1/f\u0000.md",
      "shares/share-1/f\t.md",
      ".",
      "..",
    ];
    for (const path of hostilePaths) {
      expect(
        unsignedShareEnvelopeSchema.safeParse(withPath("exact", path)).success,
        `exact path ${JSON.stringify(path)} must be rejected`,
      ).toBe(false);
    }
    // canonical paths parse; prefix selectors may carry ONE trailing slash
    expect(
      unsignedShareEnvelopeSchema.safeParse(withPath("exact", "shares/s-1/f.md")).success,
    ).toBe(true);
    expect(
      unsignedShareEnvelopeSchema.safeParse(withPath("prefix", "shares/s-1/")).success,
    ).toBe(true);
    expect(
      unsignedShareEnvelopeSchema.safeParse(withPath("prefix", "shares/s-1")).success,
    ).toBe(true);
    expect(
      unsignedShareEnvelopeSchema.safeParse(withPath("prefix", "shares/s-1//")).success,
    ).toBe(false);
    expect(
      unsignedShareEnvelopeSchema.safeParse(withPath("prefix", "shares/../")).success,
    ).toBe(false);
  });

  it("requires spaceId to be a single canonical path segment (it joins the resource URI)", () => {
    const base = makeUnsignedEnvelope();
    for (const spaceId of ["space/../other", "a/b", "..", ".", "sp%2fid", "sp\\id", ""]) {
      expect(
        unsignedShareEnvelopeSchema.safeParse({
          ...base,
          target: { ...base.target, spaceId },
        }).success,
        `spaceId ${JSON.stringify(spaceId)} must be rejected`,
      ).toBe(false);
    }
    expect(
      unsignedShareEnvelopeSchema.safeParse({
        ...base,
        target: { ...base.target, spaceId: "space-abc" },
      }).success,
    ).toBe(true);
  });

  it("signed schema requires a well-formed signature", () => {
    const signed = signEnvelope(makeUnsignedEnvelope(), TEST_PRIV_KEY);
    expect(shareEnvelopeSchema.safeParse(signed).success).toBe(true);
    expect(
      shareEnvelopeSchema.safeParse({
        ...signed,
        signature: { ...signed.signature, algorithm: "ES256" },
      }).success,
    ).toBe(false);
    expect(
      shareEnvelopeSchema.safeParse({
        ...signed,
        signature: { ...signed.signature, signerDid: "did:web:x" },
      }).success,
    ).toBe(false);
  });

  it("signature.value must decode to exactly 64 bytes", () => {
    const signed = signEnvelope(makeUnsignedEnvelope(), TEST_PRIV_KEY);
    const bad = ["", "AAAA", `${signed.signature.value}AAAA`, `${signed.signature.value}==`];
    for (const value of bad) {
      expect(
        shareEnvelopeSchema.safeParse({
          ...signed,
          signature: { ...signed.signature, value },
        }).success,
      ).toBe(false);
    }
  });
});

describe("target.origin canonical https origin", () => {
  const accepted = [
    "https://share.tinycloud.xyz",
    "https://example.com",
    "https://example.com:8443", // non-default port stays
  ];
  const rejected = [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.com",
    "http://example.com", // https only
    "https://example.com/", // trailing slash — not the origin serialization
    "https://example.com/path",
    "https://example.com?q=1",
    "https://example.com#frag",
    "https://user:pass@example.com", // userinfo
    "https://user@example.com",
    "https://example.com:443", // default-port alias of the canonical form
    "https://EXAMPLE.com", // non-lowercase host
    "https://", // no host
    "not a url",
  ];

  it("accepts canonical https origins", () => {
    for (const origin of accepted) {
      expect(isCanonicalHttpsOrigin(origin)).toBe(true);
      const parsed = unsignedShareEnvelopeSchema.safeParse(
        makeUnsignedEnvelope({
          target: { ...makeUnsignedEnvelope().target, origin },
        }),
      );
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects everything that is not exactly an https origin", () => {
    for (const origin of rejected) {
      expect(isCanonicalHttpsOrigin(origin)).toBe(false);
      const parsed = unsignedShareEnvelopeSchema.safeParse(
        makeUnsignedEnvelope({
          target: { ...makeUnsignedEnvelope().target, origin },
        }),
      );
      expect(parsed.success).toBe(false);
    }
  });
});

describe("ed25519 verification mode: strict RFC 8032, not ZIP-215", () => {
  // Non-canonical encoding of the identity point: y = p + 1 = 2^255 - 18,
  // which is >= p and therefore rejected by strict RFC 8032 decoding, but
  // reduced mod p (to the identity, y = 1) under ZIP-215 rules. With
  // R = that encoding and s = 0, the signature equation degenerates to
  // 0 = 0, so ZIP-215 verifiers accept it for ANY message — a strict
  // verifier (like a Rust ed25519-dalek verify_strict) must not.
  const NONCANONICAL_IDENTITY = (() => {
    const bytes = new Uint8Array(32).fill(0xff);
    bytes[0] = 0xee; // little-endian 2^255 - 18
    bytes[31] = 0x7f;
    return bytes;
  })();

  it("rejects a known non-canonical encoding that ZIP-215 accepts", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519");
    const signature = new Uint8Array(64); // R = non-canonical identity, s = 0
    signature.set(NONCANONICAL_IDENTITY, 0);
    const message = new TextEncoder().encode("any message");
    // Sanity: this really is in the ZIP-215-only acceptance set…
    expect(
      ed25519.verify(signature, message, NONCANONICAL_IDENTITY, { zip215: true }),
    ).toBe(true);
    // …and strict mode (what this package uses) rejects it.
    expect(
      ed25519.verify(signature, message, NONCANONICAL_IDENTITY, { zip215: false }),
    ).toBe(false);
  });

  it("verifyEnvelopeSignatureOnly rejects the same degenerate signature end-to-end", async () => {
    const { toBase64Url } = await import("../src/bytes.js");
    const signature = new Uint8Array(64);
    signature.set(NONCANONICAL_IDENTITY, 0);
    const forged = {
      ...makeUnsignedEnvelope(),
      signature: {
        signerDid: didKeyFromEd25519PublicKey(NONCANONICAL_IDENTITY),
        algorithm: "Ed25519" as const,
        value: toBase64Url(signature),
      },
    };
    expect(verifyEnvelopeSignatureOnly(forged)).toBe(false);
    expect(
      await verifyEnvelope(forged, { expectedSignerDid: forged.signature.signerDid }),
    ).toBe(false);
  });
});

describe("bearer helper", () => {
  it("returns the embedded session JWK for bearerKey envelopes", () => {
    const signed = signEnvelope(
      makeUnsignedEnvelope({ authorizationTarget: BEARER_TARGET }),
      TEST_PRIV_KEY,
    );
    expect(getBearerSessionJwk(signed)).toEqual(
      BEARER_TARGET.kind === "bearerKey" ? BEARER_TARGET.sessionJwk : undefined,
    );
  });

  it("throws for non-bearer envelopes", () => {
    const signed = signEnvelope(makeUnsignedEnvelope(), TEST_PRIV_KEY);
    expect(() => getBearerSessionJwk(signed)).toThrow(TypeError);
  });
});
