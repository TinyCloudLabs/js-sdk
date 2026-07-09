import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { privateKeyToAccount } from "viem/accounts";
import { bases } from "multiformats/basics";
import {
  ED25519_JCS_SIGNATURE_SUITE,
  EIP191_JCS_SIGNATURE_SUITE,
  POLICY_ENGINE_RECORD_SCHEMA,
  POLICY_SCHEMA,
  POLICY_STATUS_SCHEMA,
  SignatureMaterialError,
  SignedObjectCanonicalizationError,
  SignedObjectProfileError,
  SignedObjectSchemaError,
  SigningKeyBindingError,
  UnsupportedSignatureSuiteError,
  createAndSignPolicy,
  deriveSignedObjectMaterial,
  jcsCanonicalize,
  validatePolicyEngineRecordSignedShape,
  validatePolicySignedShape,
  validatePolicyStatusSignedShape,
  verifySignedObject,
  type SignedObjectSigner,
  type SignedPolicyObject,
} from "./index";

interface VectorObject {
  object_type: string;
  id_field: string;
  id: string;
  domain: string;
  unsigned: Record<string, unknown>;
  unsigned_jcs_utf8_hex: string;
  digest_hex: string;
  signature: {
    suite: string;
    signerDid: string;
    value: string;
  };
}

const objectsFixture = (await Bun.file(
  "test-fixtures/policy-engine-vectors/signed-object-profile/objects.json",
).json()) as { objects: VectorObject[] };

const suitesFixture = (await Bun.file(
  "test-fixtures/policy-engine-vectors/signed-object-profile/signature-suites.json",
).json()) as {
  ed25519: Record<string, { seed_hex: string; did: string }>;
  secp256k1: Record<string, { private_key_hex: string; did: string }>;
};

const negativeFixture = (await Bun.file(
  "test-fixtures/policy-engine-vectors/signed-object-profile/negative.json",
).json()) as { cases: Array<Record<string, unknown>> };

const coveredKinds = new Set(["Policy", "PolicyStatus", "PolicyEngineRecord"]);
const coveredVectors = objectsFixture.objects.filter((entry) =>
  coveredKinds.has(entry.object_type),
);

function signedFromVector(vector: VectorObject): SignedPolicyObject {
  return {
    ...vector.unsigned,
    [vector.id_field]: vector.id,
    signature: vector.signature,
  } as SignedPolicyObject;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function nonCanonicalBase64UrlFor(bytes: Uint8Array): string {
  const encoded = bytesToBase64Url(bytes);
  const last = encoded.at(-1);
  if (last === undefined) {
    throw new Error("expected non-empty base64url string");
  }
  return `${encoded.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

function edSigner(name: string): SignedObjectSigner {
  const fixture = suitesFixture.ed25519[name];
  const seed = hexToBytes(fixture.seed_hex);
  return {
    suite: ED25519_JCS_SIGNATURE_SUITE,
    signerDid: fixture.did,
    signDigest: (digest) => ed25519.sign(digest, seed),
  };
}

function eipSigner(name: string): SignedObjectSigner {
  const fixture = suitesFixture.secp256k1[name];
  const account = privateKeyToAccount(`0x${fixture.private_key_hex}`);
  return {
    suite: EIP191_JCS_SIGNATURE_SUITE,
    signerDid: fixture.did,
    signDigest: (digest) => account.signMessage({ message: { raw: digest } }),
  };
}

async function expectTypedFailure(
  action: () => unknown | Promise<unknown>,
  expected?: new (...args: never[]) => SignedObjectProfileError,
): Promise<SignedObjectProfileError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(SignedObjectProfileError);
    if (expected) {
      expect(error).toBeInstanceOf(expected);
    }
    return error as SignedObjectProfileError;
  }
  throw new Error("expected action to fail");
}

describe("signed-object profile vectors", () => {
  it("round-trips JCS bytes, digest domains, and ids for covered objects", () => {
    expect(coveredVectors.length).toBe(5);
    for (const vector of coveredVectors) {
      const material = deriveSignedObjectMaterial(vector.unsigned);
      expect(Buffer.from(material.jcsBytes).toString("hex")).toBe(
        vector.unsigned_jcs_utf8_hex,
      );
      expect(material.digestHex).toBe(vector.digest_hex);
      expect(material.domain).toBe(vector.domain);
      expect(material.id).toBe(vector.id);
      expect(material.idField).toBe(vector.id_field);
    }
  });

  it("verifies vendored signatures for the covered suite vectors", async () => {
    for (const vector of coveredVectors) {
      const result = await verifySignedObject(signedFromVector(vector));
      expect(result.material.id).toBe(vector.id);
    }
  });

  it("rejects applicable signed-object negative vectors", async () => {
    const policy = coveredVectors.find((entry) => entry.object_type === "Policy")!;
    const casesByName = new Map(
      negativeFixture.cases.map((entry) => [entry.case as string, entry]),
    );

    await expectTypedFailure(() =>
      deriveSignedObjectMaterial(
        casesByName.get("schema-invalid-missing-ownerDid")!.input_unsigned,
      ),
    );

    await expectTypedFailure(() =>
      verifySignedObject({
        ...casesByName.get("digest-mismatch-id-derived-from-other-body")!
          .unsigned,
        policyId: casesByName.get("digest-mismatch-id-derived-from-other-body")!
          .input_id,
        signature: policy.signature,
      }),
    );

    await expectTypedFailure(() =>
      verifySignedObject({
        ...policy.unsigned,
        policyId: casesByName.get("id-mismatch-wrong-prefix")!.input_id,
        signature: policy.signature,
      }),
    );

    await expectTypedFailure(() =>
      verifySignedObject({
        ...policy.unsigned,
        policyId: policy.id,
        signature: {
          ...policy.signature,
          value: casesByName.get("signature-invalid-bitflip")!
            .tampered_signature_value_b64u,
        },
      }),
    );
  });
});

describe("JCS canonicalization", () => {
  it("sorts object keys by Unicode code point", () => {
    const supplementary = "\u{10000}";
    const privateUse = "\ue000";
    expect(jcsCanonicalize({ [supplementary]: 1, [privateUse]: 2 })).toBe(
      `{"${privateUse}":2,"${supplementary}":1}`,
    );
  });

  it("rejects lone surrogates with a typed error", () => {
    expect(() => jcsCanonicalize({ s: "\uD800" })).toThrow(
      SignedObjectCanonicalizationError,
    );
  });

  it("uses RFC 8785-compatible number serialization", () => {
    expect(jcsCanonicalize({ small: 1e-27, minusZero: -0, big: 1.23e30 })).toBe(
      '{"big":1.23e+30,"minusZero":0,"small":1e-27}',
    );
  });

  it("rejects non-plain JSON inputs", () => {
    class Box {
      value = 1;
    }
    const arrayWithOwnProperty = [1] as number[] & { extra?: number };
    arrayWithOwnProperty.extra = 2;
    for (const input of [
      new Date("2026-06-01T00:00:00Z"),
      new Box(),
      { bad: undefined },
      { bad: () => undefined },
      arrayWithOwnProperty,
    ]) {
      expect(() => jcsCanonicalize(input)).toThrow(SignedObjectProfileError);
    }
  });
});

describe("create and verify signing-key binding", () => {
  it("strips stale id and signature before signing", async () => {
    const policy = coveredVectors.find((entry) => entry.object_type === "Policy")!;
    const signed = await createAndSignPolicy(
      {
        ...policy.unsigned,
        policyId: "pol_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        signature: {
          suite: ED25519_JCS_SIGNATURE_SUITE,
          signerDid: suitesFixture.ed25519.grant_issuer.did,
          value: bytesToBase64Url(new Uint8Array(64)),
        },
      },
      edSigner("policy_signer"),
    );
    expect(signed.policyId).toBe(policy.id);
    await expect(verifySignedObject(signed)).resolves.toBeTruthy();
  });

  it("refuses create signing when signerDid differs from signingKeyDid", async () => {
    const policy = coveredVectors.find((entry) => entry.object_type === "Policy")!;
    await expectTypedFailure(
      () => createAndSignPolicy(policy.unsigned, edSigner("grant_issuer")),
      SigningKeyBindingError,
    );
  });

  it("rejects a valid signature from a different did:key before signature validity", async () => {
    const policy = coveredVectors.find((entry) => entry.object_type === "Policy")!;
    const material = deriveSignedObjectMaterial(policy.unsigned);
    const signature = await edSigner("grant_issuer").signDigest(material.digest);
    await expectTypedFailure(
      () =>
        verifySignedObject({
          ...policy.unsigned,
          policyId: policy.id,
          signature: {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: suitesFixture.ed25519.grant_issuer.did,
            value: bytesToBase64Url(signature as Uint8Array),
          },
        }),
      SigningKeyBindingError,
    );
  });

  it("refuses create signing when the signer DID does not match the suite", async () => {
    const policy = coveredVectors.find((entry) => entry.object_type === "Policy")!;
    await expectTypedFailure(
      () =>
        createAndSignPolicy(
          {
            ...policy.unsigned,
            signingKeyDid: suitesFixture.secp256k1.owner_root.did,
          },
          {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: suitesFixture.secp256k1.owner_root.did,
            signDigest: () => new Uint8Array(64),
          },
        ),
      SignatureMaterialError,
    );
    await expectTypedFailure(
      () =>
        createAndSignPolicy(policy.unsigned, {
          suite: EIP191_JCS_SIGNATURE_SUITE,
          signerDid: policy.unsigned.signingKeyDid as string,
          signDigest: () => Uint8Array.from([...new Uint8Array(64), 27]),
        }),
      SignatureMaterialError,
    );
  });
});

describe("typed signature-material failures", () => {
  const engine = coveredVectors.find(
    (entry) => entry.object_type === "PolicyEngineRecord",
  )!;

  it("rejects malformed signature encodings with a typed error", async () => {
    await expectTypedFailure(
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: suitesFixture.ed25519.policy_signer.did,
            value: "not*base64url",
          },
        }),
      SignatureMaterialError,
    );
  });

  it("rejects wrong-length signature encodings with a typed error", async () => {
    await expectTypedFailure(
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: suitesFixture.ed25519.policy_signer.did,
            value: "AAAA",
          },
        }),
      SignatureMaterialError,
    );
  });

  it("rejects unsupported suites with a typed error", async () => {
    await expectTypedFailure(
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: "unknown-suite",
            signerDid: suitesFixture.ed25519.policy_signer.did,
            value: bytesToBase64Url(new Uint8Array(64)),
          },
        }),
      UnsupportedSignatureSuiteError,
    );
  });

  it("rejects undecodable did:key signers with a typed error", async () => {
    await expectTypedFailure(
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: "did:key:znot-valid",
            value: bytesToBase64Url(new Uint8Array(64)),
          },
        }),
      SignatureMaterialError,
    );
  });

  it("rejects undecodable did:pkh signers with a typed error", async () => {
    await expectTypedFailure(
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: EIP191_JCS_SIGNATURE_SUITE,
            signerDid: "did:pkh:eip155:1:not-an-address",
            value: bytesToBase64Url(Uint8Array.from([...new Uint8Array(64), 27])),
          },
        }),
      SignatureMaterialError,
    );
  });

  it("keeps every signature-material failure in the typed hierarchy", async () => {
    const failures = [
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: suitesFixture.ed25519.policy_signer.did,
            value: "not*base64url",
          },
        }),
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: suitesFixture.ed25519.policy_signer.did,
            value: "AAAA",
          },
        }),
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: "unknown-suite",
            signerDid: suitesFixture.ed25519.policy_signer.did,
            value: bytesToBase64Url(new Uint8Array(64)),
          },
        }),
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: "did:key:znot-valid",
            value: bytesToBase64Url(new Uint8Array(64)),
          },
        }),
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: EIP191_JCS_SIGNATURE_SUITE,
            signerDid: "did:pkh:eip155:1:not-an-address",
            value: bytesToBase64Url(Uint8Array.from([...new Uint8Array(64), 27])),
          },
        }),
    ];

    for (const fail of failures) {
      const error = await expectTypedFailure(fail);
      expect(error).toBeInstanceOf(SignedObjectProfileError);
    }
  });

  it("rejects non-canonical base64url signature encodings", async () => {
    await expectTypedFailure(
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: suitesFixture.ed25519.policy_signer.did,
            value: nonCanonicalBase64UrlFor(new Uint8Array(64)),
          },
        }),
      SignatureMaterialError,
    );
  });

  it("rejects shortened Ed25519 did:key encodings", async () => {
    const publicKey = ed25519.getPublicKey(
      hexToBytes(suitesFixture.ed25519.policy_signer.seed_hex),
    );
    const shortenedDid = `did:key:${bases.base58btc.encode(
      Uint8Array.from([0xed, ...publicKey]),
    )}`;
    await expectTypedFailure(
      () =>
        verifySignedObject({
          ...engine.unsigned,
          engineRecordId: engine.id,
          signature: {
            suite: ED25519_JCS_SIGNATURE_SUITE,
            signerDid: shortenedDid,
            value: bytesToBase64Url(new Uint8Array(64)),
          },
        }),
      SignatureMaterialError,
    );
  });

  it("verifies a freshly signed EIP-191 object", async () => {
    const statusVector = coveredVectors.find(
      (entry) =>
        entry.object_type === "PolicyStatus" &&
        entry.signature.suite === EIP191_JCS_SIGNATURE_SUITE,
    )!;
    const signed = await createAndSignPolicy(
      {
        schema: POLICY_SCHEMA,
        ownerDid: suitesFixture.secp256k1.owner_root.did,
        signingKeyDid: suitesFixture.secp256k1.owner_root.did,
        createdAt: "2026-06-01T00:00:00Z",
        resource: {
          resourceType: "collection",
          resourceId: "conv_456",
          permissionsCeiling: [
            {
              service: "tinycloud.sql",
              space: "applications",
              path: "xyz.tinycloud.listen/conversations",
              actions: ["tinycloud.sql/read"],
            },
          ],
        },
        when: { subject: { did: suitesFixture.secp256k1.eligible_subject.did } },
        grant: {
          output: "portable-delegation",
          maxTtlSeconds: 300,
          delegationMode: "terminal",
          revocation: "active_cutoff",
        },
      },
      eipSigner("owner_root"),
    );
    await expect(verifySignedObject(signed)).resolves.toBeTruthy();
    await expect(verifySignedObject(signedFromVector(statusVector))).resolves.toBeTruthy();
  });
});

describe("structural validation", () => {
  const policy = signedFromVector(
    coveredVectors.find((entry) => entry.object_type === "Policy")!,
  );
  const status = signedFromVector(
    coveredVectors.find((entry) => entry.object_type === "PolicyStatus")!,
  );
  const engine = signedFromVector(
    coveredVectors.find((entry) => entry.object_type === "PolicyEngineRecord")!,
  );

  it("accepts canonical signed shapes for all three objects", () => {
    expect(validatePolicySignedShape(policy).schema).toBe(POLICY_SCHEMA);
    expect(
      validatePolicySignedShape({
        ...policy,
        expiresAt: "2026-07-01T00:00:00Z",
      }).expiresAt,
    ).toBe("2026-07-01T00:00:00Z");
    expect(validatePolicyStatusSignedShape(status).schema).toBe(POLICY_STATUS_SCHEMA);
    expect(validatePolicyEngineRecordSignedShape(engine).schema).toBe(
      POLICY_ENGINE_RECORD_SCHEMA,
    );
  });

  it("rejects malformed Policy createdAt and expiresAt fields", async () => {
    const missingCreatedAt = { ...policy };
    delete (missingCreatedAt as Record<string, unknown>).createdAt;
    for (const bad of [
      missingCreatedAt,
      { ...policy, createdAt: null },
      { ...policy, createdAt: 123 },
      { ...policy, createdAt: "not-a-date" },
      { ...policy, createdAt: "2026-02-31T00:00:00Z" },
      { ...policy, createdAt: "2026-06-01T00:00:00+00:00" },
      { ...policy, expiresAt: null },
      { ...policy, expiresAt: 123 },
      { ...policy, expiresAt: "not-a-date" },
      { ...policy, expiresAt: "2026-02-31T00:00:00Z" },
      { ...policy, expiresAt: "2026-07-01T00:00:00+00:00" },
    ]) {
      await expectTypedFailure(() => verifySignedObject(bad), SignedObjectSchemaError);
    }
  });

  it("rejects malformed PolicyStatus effectiveAt fields", async () => {
    const missingEffectiveAt = { ...status };
    delete (missingEffectiveAt as Record<string, unknown>).effectiveAt;
    for (const bad of [
      missingEffectiveAt,
      { ...status, effectiveAt: null },
      { ...status, effectiveAt: 123 },
      { ...status, effectiveAt: "not-a-date" },
      { ...status, effectiveAt: "2026-02-31T00:00:00Z" },
      { ...status, effectiveAt: "2026-06-01T00:00:00+00:00" },
    ]) {
      await expectTypedFailure(() => verifySignedObject(bad), SignedObjectSchemaError);
    }
  });

  it("rejects missing, null, non-string, and unparsable engine expiresAt fields", async () => {
    const missingExpiresAt = { ...engine };
    delete (missingExpiresAt as Record<string, unknown>).expiresAt;
    for (const bad of [
      missingExpiresAt,
      { ...engine, expiresAt: null },
      { ...engine, expiresAt: 123 },
      { ...engine, expiresAt: "not-a-date" },
      { ...engine, expiresAt: "2026-02-31T00:00:00Z" },
      { ...engine, expiresAt: "2027-06-01T00:00:00+00:00" },
      { ...engine, expiresAt: "2027-06-01T00:00:00.000Z" },
      { ...engine, expiresAt: "2027-06-01T00:00:00.1Z" },
    ]) {
      await expectTypedFailure(() => verifySignedObject(bad), SignedObjectSchemaError);
    }
  });

  it("rejects unknown top-level fields and type mismatches", async () => {
    await expectTypedFailure(
      () => verifySignedObject({ ...policy, extra: true }),
      SignedObjectSchemaError,
    );
    await expectTypedFailure(
      () => verifySignedObject({ ...status, extra: true }),
      SignedObjectSchemaError,
    );
    await expectTypedFailure(
      () => verifySignedObject({ ...engine, extra: true }),
      SignedObjectSchemaError,
    );
    await expectTypedFailure(
      () => verifySignedObject({ ...policy, ownerDid: 123 }),
      SignedObjectSchemaError,
    );
    await expectTypedFailure(
      () =>
        verifySignedObject({
          ...policy,
          resource: {
            ...policy.resource,
            permissionsCeiling: [
              {
                service: "tinycloud.sql",
                space: "applications",
                path: "xyz.tinycloud.listen/conversations",
                actions: ["tinycloud.sql/read"],
                caveats: "not-an-object",
              },
            ],
          },
        }),
      SignedObjectSchemaError,
    );
    await expectTypedFailure(
      () => verifySignedObject({ ...status, sequence: "1" }),
      SignedObjectSchemaError,
    );
    await expectTypedFailure(
      () => verifySignedObject({ ...engine, supportedPolicyVersions: "v0" }),
      SignedObjectSchemaError,
    );
  });

  it("rejects prototype-pollution keys on validation entrypoints", () => {
    const pollutedPolicy = JSON.parse(
      JSON.stringify(policy).replace(
        '"ownerDid"',
        '"__proto__":{"polluted":true},"ownerDid"',
      ),
    );
    const pollutedStatus = JSON.parse(
      JSON.stringify(status).replace(
        '"ownerDid"',
        '"__proto__":{"polluted":true},"ownerDid"',
      ),
    );
    const pollutedEngine = JSON.parse(
      JSON.stringify(engine).replace(
        '"ownerDid"',
        '"__proto__":{"polluted":true},"ownerDid"',
      ),
    );
    expect(() => validatePolicySignedShape(pollutedPolicy)).toThrow(
      SignedObjectProfileError,
    );
    expect(() => validatePolicyStatusSignedShape(pollutedStatus)).toThrow(
      SignedObjectProfileError,
    );
    expect(() => validatePolicyEngineRecordSignedShape(pollutedEngine)).toThrow(
      SignedObjectProfileError,
    );
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("does not treat constructor keys as field values", () => {
    expect(() =>
      validatePolicySignedShape({
        ...policy,
        constructor: "did:key:z6MkNotAField",
      }),
    ).toThrow(SignedObjectProfileError);
    expect(() =>
      validatePolicyStatusSignedShape({
        ...status,
        constructor: "did:key:z6MkNotAField",
      }),
    ).toThrow(SignedObjectProfileError);
    expect(() =>
      validatePolicyEngineRecordSignedShape({
        ...engine,
        constructor: "did:key:z6MkNotAField",
      }),
    ).toThrow(SignedObjectProfileError);
  });
});

describe("did:key derivation sanity", () => {
  it("matches the vendored policy signer DID from the Ed25519 public key", () => {
    const publicKey = ed25519.getPublicKey(
      hexToBytes(suitesFixture.ed25519.policy_signer.seed_hex),
    );
    const did = `did:key:${bases.base58btc.encode(
      Uint8Array.from([0xed, 0x01, ...publicKey]),
    )}`;
    expect(did).toBe(suitesFixture.ed25519.policy_signer.did);
  });
});
