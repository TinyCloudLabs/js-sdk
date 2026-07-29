/**
 * Bearer delegation mint ↔ check: both sides live in ONE module
 * (src/bearer-delegation.ts) precisely so these round-trip tests pin the
 * shared convention — a minted token must be exactly what the check accepts.
 * (The full adversarial matrix for `checkBearerDelegation` — garbage tokens,
 * wrong aud/ability/resource/origin/space — lives in the viewer suite, which
 * consumes this module through the viewer's delegation shim.)
 */
import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";

import {
  BEARER_READ_ABILITY,
  READ_ABILITIES,
  bearerResourceUri,
  checkBearerDelegation,
  mintBearerDelegation,
  requiredResourceUri,
  resourceUriCovers,
} from "../src/bearer-delegation.js";
import { fromBase64Url, toBase64Url, utf8Bytes } from "../src/bytes.js";
import { didKeyFromEd25519PublicKey } from "../src/didkey.js";
import { shareEnvelopeSchema } from "../src/schema.js";
import { signEnvelope } from "../src/sign.js";
import { BEARER_TARGET, TEST_PRIV_KEY, makeUnsignedEnvelope } from "./fixtures.js";

const ISSUER_PRIV = new Uint8Array(32).fill(11);
const ISSUER_DID = didKeyFromEd25519PublicKey(ed25519.getPublicKey(ISSUER_PRIV));
/** did:key of the BEARER_TARGET fixture's embedded session key. */
const SESSION_DID = didKeyFromEd25519PublicKey(
  fromBase64Url(
    BEARER_TARGET.kind === "bearerKey" ? BEARER_TARGET.sessionJwk.x : "",
  ),
);
const EXP = Math.floor(Date.parse("2099-01-01T00:00:00Z") / 1000);

describe("bearerResourceUri convention", () => {
  it("is <origin>/<spaceId>/<path>, and requiredResourceUri agrees", () => {
    expect(
      bearerResourceUri("https://share.tinycloud.xyz", "space-abc", "shares/s/f.md"),
    ).toBe("https://share.tinycloud.xyz/space-abc/shares/s/f.md");
    const envelope = signEnvelope(
      makeUnsignedEnvelope({ authorizationTarget: BEARER_TARGET }),
      TEST_PRIV_KEY,
    );
    expect(requiredResourceUri(envelope)).toBe(
      bearerResourceUri(
        envelope.target.origin,
        envelope.target.spaceId,
        envelope.target.resource.path,
      ),
    );
  });

  it("mint and check share EXACTLY one ability — provably identical, no drift", () => {
    expect(READ_ABILITIES.has(BEARER_READ_ABILITY)).toBe(true);
    expect([...READ_ABILITIES]).toEqual([BEARER_READ_ABILITY]);
  });
});

describe("resourceUriCovers (canonical grammar, segment boundaries, fail closed)", () => {
  const BASE = "https://share.tinycloud.xyz/space-abc";

  it("covers exact matches and strictly-deeper /* prefixes on segment boundaries", () => {
    expect(resourceUriCovers(`${BASE}/shares/s1/f.md`, `${BASE}/shares/s1/f.md`)).toBe(true);
    expect(resourceUriCovers(`${BASE}/shares/s1/*`, `${BASE}/shares/s1/f.md`)).toBe(true);
    expect(resourceUriCovers(`${BASE}/shares/s1/*`, `${BASE}/shares/s1/a/b.md`)).toBe(true);
    // a bare "/*" grant does not cover its own base (strictly deeper only)
    expect(resourceUriCovers(`${BASE}/shares/s1/*`, `${BASE}/shares/s1`)).toBe(false);
    // segment boundary: "shares/s1/*" never bleeds into "shares/s12"
    expect(resourceUriCovers(`${BASE}/shares/s1/*`, `${BASE}/shares/s12/f.md`)).toBe(false);
    // no mid-segment glob
    expect(resourceUriCovers(`${BASE}/shares/s*`, `${BASE}/shares/s1`)).toBe(false);
  });

  it("rejects traversal aliases outright — never normalized-and-accepted", () => {
    // the finding's exact shape: shares/share-1/../victim.md under shares/share-1/*
    expect(
      resourceUriCovers(`${BASE}/shares/share-1/*`, `${BASE}/shares/share-1/../victim.md`),
    ).toBe(false);
    // .. in the GRANT is equally dead, even as an exact string match
    const traversal = `${BASE}/shares/share-1/../victim.md`;
    expect(resourceUriCovers(traversal, traversal)).toBe(false);
    expect(resourceUriCovers(`${BASE}/shares/./s1/*`, `${BASE}/shares/s1/f.md`)).toBe(false);
  });

  it("rejects //, percent-encoded separators, backslash, and control chars on either side", () => {
    const target = `${BASE}/shares/s1/f.md`;
    for (const hostile of [
      `${BASE}/shares//s1/*`,
      `${BASE}/shares/s1%2f../*`,
      `${BASE}/shares/s1%2F../*`,
      `${BASE}/shares/s1%2e%2e/*`,
      `${BASE}/shares\\s1/*`,
      `${BASE}/shares/s1\u0000/*`,
    ]) {
      expect(resourceUriCovers(hostile, target)).toBe(false);
    }
    for (const hostileTarget of [
      `${BASE}/shares//s1/f.md`,
      `${BASE}/shares/s1/%2e%2e/f.md`,
      `${BASE}/shares/s1/..%2ff.md`,
    ]) {
      expect(resourceUriCovers(`${BASE}/shares/*`, hostileTarget)).toBe(false);
    }
  });

  it("rejects non-https and non-canonical origins and cross-origin grants", () => {
    expect(
      resourceUriCovers(
        "http://share.tinycloud.xyz/space-abc/shares/s1/*",
        `${BASE}/shares/s1/f.md`,
      ),
    ).toBe(false);
    expect(
      resourceUriCovers(
        "https://evil.example/space-abc/shares/s1/*",
        `${BASE}/shares/s1/f.md`,
      ),
    ).toBe(false);
    // default-port alias is a different string for the same origin: rejected
    expect(
      resourceUriCovers(
        "https://share.tinycloud.xyz:443/space-abc/shares/s1/*",
        `${BASE}/shares/s1/f.md`,
      ),
    ).toBe(false);
  });
});

describe("checkBearerDelegation cryptographic verification (signature, exp, nbf)", () => {
  /** Sign an arbitrary header/payload pair like the mint does. */
  function signToken(
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
    privateKey: Uint8Array = ISSUER_PRIV,
  ): string {
    const encode = (value: unknown): string =>
      toBase64Url(utf8Bytes(JSON.stringify(value)));
    const signingInput = `${encode(header)}.${encode(payload)}`;
    return `${signingInput}.${toBase64Url(
      ed25519.sign(utf8Bytes(signingInput), privateKey),
    )}`;
  }

  const HEADER = { alg: "EdDSA", typ: "JWT", ucv: "0.9.1" };

  function envelopeWithDelegation(delegation: string) {
    const unsigned = makeUnsignedEnvelope({ authorizationTarget: BEARER_TARGET });
    return signEnvelope({ ...unsigned, delegation }, TEST_PRIV_KEY);
  }

  /** The correctly-bound payload for the fixture envelope's signed target. */
  function boundPayload(): Record<string, unknown> {
    const probe = envelopeWithDelegation("a.b.c"); // just to read the target
    return {
      iss: ISSUER_DID,
      aud: SESSION_DID,
      att: [{ with: requiredResourceUri(probe), can: BEARER_READ_ABILITY }],
      prf: [],
      exp: EXP,
    };
  }

  it("valid self-signed token → ok (baseline)", () => {
    const envelope = envelopeWithDelegation(signToken(HEADER, boundPayload()));
    expect(checkBearerDelegation(envelope)).toEqual({
      ok: true,
      delegateeDid: SESSION_DID,
    });
  });

  it("stub (non-EdDSA-valid) signature bytes → rejected", () => {
    const encode = (value: unknown): string =>
      toBase64Url(utf8Bytes(JSON.stringify(value)));
    const stub = `${encode(HEADER)}.${encode(boundPayload())}.${toBase64Url(
      utf8Bytes("stub-signature"),
    )}`;
    const result = checkBearerDelegation(envelopeWithDelegation(stub));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/signature/);
  });

  it("tampered payload (signature no longer matches) → rejected", () => {
    const payload = boundPayload();
    const token = signToken(HEADER, payload);
    const [h, , s] = token.split(".") as [string, string, string];
    const tampered = `${h}.${toBase64Url(
      utf8Bytes(JSON.stringify({ ...payload, prf: ["injected"] })),
    )}.${s}`;
    expect(checkBearerDelegation(envelopeWithDelegation(tampered)).ok).toBe(false);
  });

  it("token signed by a key that is NOT iss → rejected", () => {
    const otherKey = new Uint8Array(32).fill(42);
    const token = signToken(HEADER, boundPayload(), otherKey); // iss stays ISSUER_DID
    expect(checkBearerDelegation(envelopeWithDelegation(token)).ok).toBe(false);
  });

  it("wrong alg (ES256) → rejected even with an otherwise valid token", () => {
    const token = signToken({ ...HEADER, alg: "ES256" }, boundPayload());
    const result = checkBearerDelegation(envelopeWithDelegation(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/alg/);
  });

  it("missing or non-did:key iss → rejected", () => {
    const { iss: _dropped, ...withoutIss } = boundPayload();
    expect(
      checkBearerDelegation(envelopeWithDelegation(signToken(HEADER, withoutIss))).ok,
    ).toBe(false);
    expect(
      checkBearerDelegation(
        envelopeWithDelegation(
          signToken(HEADER, { ...boundPayload(), iss: "did:web:example.com" }),
        ),
      ).ok,
    ).toBe(false);
  });

  it("missing exp → rejected (expiry-less delegations fail closed)", () => {
    const { exp: _dropped, ...withoutExp } = boundPayload();
    const result = checkBearerDelegation(
      envelopeWithDelegation(signToken(HEADER, withoutExp)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/exp/);
  });

  it("non-numeric / non-integer exp → rejected", () => {
    for (const exp of ["2099-01-01", 1.5, Number.NaN, null, -5]) {
      expect(
        checkBearerDelegation(
          envelopeWithDelegation(signToken(HEADER, { ...boundPayload(), exp })),
        ).ok,
      ).toBe(false);
    }
  });

  it("expired delegation → rejected; boundary is exact and clock-injectable", () => {
    const expired = envelopeWithDelegation(
      signToken(HEADER, {
        ...boundPayload(),
        exp: Math.floor(Date.parse("2020-01-01T00:00:00Z") / 1000),
      }),
    );
    const result = checkBearerDelegation(expired);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/expired/);
    // exactly at exp*1000 the token is dead; one ms before it is alive
    const alive = envelopeWithDelegation(signToken(HEADER, boundPayload()));
    expect(checkBearerDelegation(alive, { now: () => EXP * 1000 }).ok).toBe(false);
    expect(checkBearerDelegation(alive, { now: () => EXP * 1000 - 1 }).ok).toBe(true);
  });

  it("future nbf → rejected until it arrives; past nbf → ok", () => {
    const nbf = Math.floor(Date.parse("2098-01-01T00:00:00Z") / 1000);
    const notYet = envelopeWithDelegation(
      signToken(HEADER, { ...boundPayload(), nbf }),
    );
    const result = checkBearerDelegation(notYet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/nbf/);
    expect(checkBearerDelegation(notYet, { now: () => nbf * 1000 }).ok).toBe(true);
    const past = envelopeWithDelegation(
      signToken(HEADER, { ...boundPayload(), nbf: 1_000_000 }),
    );
    expect(checkBearerDelegation(past).ok).toBe(true);
  });
});

describe("mintBearerDelegation → checkBearerDelegation round trip", () => {
  function mintedEnvelope() {
    const unsigned = makeUnsignedEnvelope({ authorizationTarget: BEARER_TARGET });
    const delegation = mintBearerDelegation({
      issuerPrivateKey: ISSUER_PRIV,
      audienceDid: SESSION_DID,
      resourceUri: bearerResourceUri(
        unsigned.target.origin,
        unsigned.target.spaceId,
        unsigned.target.resource.path,
      ),
      expiresAtSeconds: EXP,
    });
    return signEnvelope({ ...unsigned, delegation }, TEST_PRIV_KEY);
  }

  it("a minted delegation passes the structural check with the session DID bound", () => {
    const envelope = mintedEnvelope();
    const result = checkBearerDelegation(envelope);
    expect(result).toEqual({ ok: true, delegateeDid: SESSION_DID });
  });

  it("mints a decodable JWT-shaped token with the expected claims", () => {
    const envelope = mintedEnvelope();
    const [headerB64, payloadB64, sigB64] = envelope.delegation.split(".") as [
      string,
      string,
      string,
    ];
    const decode = (segment: string): unknown =>
      JSON.parse(new TextDecoder().decode(fromBase64Url(segment)));
    expect(decode(headerB64)).toEqual({ alg: "EdDSA", typ: "JWT", ucv: "0.9.1" });
    expect(decode(payloadB64)).toEqual({
      iss: ISSUER_DID,
      aud: SESSION_DID,
      att: [
        {
          with: requiredResourceUri(envelope),
          can: BEARER_READ_ABILITY,
        },
      ],
      prf: [],
      exp: EXP,
    });
    // The signature is REAL EdDSA over the JWS signing input by `iss`.
    const verified = ed25519.verify(
      fromBase64Url(sigB64),
      utf8Bytes(`${headerB64}.${payloadB64}`),
      ed25519.getPublicKey(ISSUER_PRIV),
      { zip215: false },
    );
    expect(verified).toBe(true);
  });

  it("a minted token for a DIFFERENT audience fails the check (no drift both ways)", () => {
    const unsigned = makeUnsignedEnvelope({ authorizationTarget: BEARER_TARGET });
    const delegation = mintBearerDelegation({
      issuerPrivateKey: ISSUER_PRIV,
      audienceDid: ISSUER_DID, // not the embedded session key
      resourceUri: requiredResourceUri(
        signEnvelope(unsigned, TEST_PRIV_KEY),
      ),
      expiresAtSeconds: EXP,
    });
    const envelope = signEnvelope({ ...unsigned, delegation }, TEST_PRIV_KEY);
    const result = checkBearerDelegation(envelope);
    expect(result.ok).toBe(false);
  });

  it("a minted token for a non-covering resource fails the check", () => {
    const unsigned = makeUnsignedEnvelope({ authorizationTarget: BEARER_TARGET });
    const delegation = mintBearerDelegation({
      issuerPrivateKey: ISSUER_PRIV,
      audienceDid: SESSION_DID,
      resourceUri: bearerResourceUri(
        unsigned.target.origin,
        unsigned.target.spaceId,
        "somewhere/else.md",
      ),
      expiresAtSeconds: EXP,
    });
    const envelope = signEnvelope({ ...unsigned, delegation }, TEST_PRIV_KEY);
    expect(checkBearerDelegation(envelope).ok).toBe(false);
  });

  it("the minted+signed envelope round-trips the strict schema", () => {
    const envelope = mintedEnvelope();
    expect(shareEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))).toEqual(
      envelope,
    );
  });

  it("rejects invalid mint inputs (fail closed at create time)", () => {
    const good = {
      issuerPrivateKey: ISSUER_PRIV,
      audienceDid: SESSION_DID,
      resourceUri: "https://share.tinycloud.xyz/s/x.md",
      expiresAtSeconds: EXP,
    };
    expect(() =>
      mintBearerDelegation({ ...good, audienceDid: "not-a-did" }),
    ).toThrow(/must be a DID/);
    expect(() => mintBearerDelegation({ ...good, resourceUri: "" })).toThrow(
      /non-empty/,
    );
    for (const exp of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        mintBearerDelegation({ ...good, expiresAtSeconds: exp }),
      ).toThrow(/positive integer/);
    }
  });
});
