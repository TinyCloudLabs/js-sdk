import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ED25519_JCS_SIGNATURE_SUITE,
  POLICY_ENGINE_RECORD_SCHEMA,
  POLICY_SCHEMA,
  PolicyAuthoringError,
  PolicyCapabilityError,
  TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA,
  W3C_VC_CREDENTIAL_VERIFIER,
  canonicalizePolicyCapability,
  composeTranscriptShareBootstrap,
  createAndSignPolicy,
  createAndSignRequesterPolicyEngineRecord,
  createAndSignTranscriptSharePolicy,
  createUnsignedPolicyEngineRecord,
  deriveSignedObjectMaterial,
  jcsCanonicalize,
  normalizePolicyCapability,
  policyCapabilityContains,
  policyCapabilityDigestHex,
  verifyPolicyEngineRecordForRequester,
  type PolicyCapabilityErrorCode,
  type SignedObjectSigner,
} from "./index";

interface CapabilityVector {
  name: string;
  input: unknown;
  canonical?: unknown;
  canonical_jcs_utf8_hex?: string;
  policy_capability_hash_hex?: string;
  rejection_code?: PolicyCapabilityErrorCode;
  auth?: unknown;
  req?: unknown;
  contained?: boolean;
}

const canonicalizationVectors = (await Bun.file(
  "test-fixtures/policy-engine-vectors/policy-capability/canonicalization-vectors.json",
).json()) as { vectors: CapabilityVector[] };
const rejectionVectors = (await Bun.file(
  "test-fixtures/policy-engine-vectors/policy-capability/rejection-vectors.json",
).json()) as { vectors: CapabilityVector[] };
const containmentVectors = (await Bun.file(
  "test-fixtures/policy-engine-vectors/policy-capability/containment-vectors.json",
).json()) as { vectors: CapabilityVector[] };
const suitesFixture = (await Bun.file(
  "test-fixtures/policy-engine-vectors/signed-object-profile/signature-suites.json",
).json()) as { ed25519: Record<string, { seed_hex: string; did: string }> };
const objectsFixture = (await Bun.file(
  "test-fixtures/policy-engine-vectors/signed-object-profile/objects.json",
).json()) as { objects: Array<{ object_type: string; unsigned: Record<string, unknown> }> };

function concretePolicyVector() {
  return objectsFixture.objects.find(
    (entry) =>
      entry.object_type === "Policy" &&
      entry.unsigned.resource !== undefined &&
      ((entry.unsigned.resource as { resourceId?: unknown }).resourceId === "conv_456"),
  )!;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
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

function expectCapabilityFailure(
  action: () => unknown,
  code: PolicyCapabilityErrorCode,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyCapabilityError);
    expect((error as PolicyCapabilityError).code).toBe(code);
    return;
  }
  throw new Error("expected capability failure");
}

function tamperBase64Url(value: string): string {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

async function expectAuthoringFailure(
  action: () => unknown | Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyAuthoringError);
    expect((error as PolicyAuthoringError).code).toBe(code);
    return;
  }
  throw new Error("expected authoring failure");
}

const sqlCapability = {
  service: "tinycloud.sql",
  space: "applications",
  path: "xyz.tinycloud.listen/conversations",
  actions: ["tinycloud.sql/read"],
  caveats: {
    mode: "constrained-statements",
    readOnly: true,
    statements: [
      {
        name: "listen.getConversation",
        sql: "SELECT id FROM conversation WHERE id = ?",
        fixedParams: [{ index: 0, value: "conv_456" }],
      },
    ],
  },
};

const exactKvCapability = {
  service: "tinycloud.kv",
  space: "applications",
  path: "notebooks/nb_project_notes/docs/alice-note.md",
  actions: ["tinycloud.kv/get"],
};

const baseGrant = {
  output: "portable-delegation",
  maxTtlSeconds: 300,
  delegationMode: "terminal",
  revocation: "active_cutoff",
};
const OWNER_DID = "did:pkh:eip155:1:0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const SUBJECT_DID = "did:pkh:eip155:1:0x7564105e977516c53be337314c7e53838967bdac";

describe("policy capability frozen vectors", () => {
  it("passes every canonicalization vector as committed", () => {
    for (const vector of canonicalizationVectors.vectors) {
      const canonical = canonicalizePolicyCapability(vector.input);
      expect(canonical).toEqual(vector.canonical);
      expect(Buffer.from(jcsCanonicalize(canonical)).toString("hex")).toBe(
        vector.canonical_jcs_utf8_hex,
      );
      expect(policyCapabilityDigestHex(vector.input)).toBe(
        vector.policy_capability_hash_hex,
      );
    }
  });

  it("passes every rejection vector as committed", () => {
    for (const vector of rejectionVectors.vectors) {
      expectCapabilityFailure(
        () => canonicalizePolicyCapability(vector.input),
        vector.rejection_code!,
      );
    }
  });

  it("passes every containment vector as committed", () => {
    for (const vector of containmentVectors.vectors) {
      expect(policyCapabilityContains(vector.auth, vector.req)).toBe(
        vector.contained,
      );
    }
  });

  it("does not widen constrained SQL authority when the request omits caveats", () => {
    const uncaveatedRequest = { ...sqlCapability };
    delete (uncaveatedRequest as { caveats?: unknown }).caveats;

    expect(policyCapabilityContains(sqlCapability, uncaveatedRequest)).toBe(false);
  });
});

describe("strict authoring capability validation", () => {
  it("accepts concrete resolved Listen-adapter capability JSON", () => {
    expect(normalizePolicyCapability(exactKvCapability)).toEqual({
      service: "tinycloud.kv",
      space: "applications",
      path: "notebooks/nb_project_notes/docs/alice-note.md",
      actions: ["tinycloud.kv/get"],
    });
    expect(normalizePolicyCapability(sqlCapability).caveats).toBeTruthy();
  });

  it("rejects manifest-shaped permissions and services outside the ceiling", () => {
    expectCapabilityFailure(
      () =>
        normalizePolicyCapability({
          id: "notebook-read",
          service: "tinycloud.kv",
          actions: ["read"],
          scope: { path: "notebooks/nb_project_notes/docs/" },
        }),
      "policy-capability-malformed",
    );
    expectCapabilityFailure(
      () =>
        normalizePolicyCapability({
          service: "tinycloud.hooks",
          space: "applications",
          path: "hooks/listener",
          actions: ["tinycloud.hooks/list"],
        }),
      "policy-capability-malformed-service",
    );
  });

  it("rejects trailing slash prefix paths items/ and notebooks/ before normalization", () => {
    for (const path of ["items/", "notebooks/"]) {
      expectCapabilityFailure(
        () =>
          normalizePolicyCapability({
            ...exactKvCapability,
            path,
          }),
        "policy-capability-malformed-path",
      );
    }
  });

  it("rejects empty path segments through the exported canonicalizer", () => {
    for (const path of ["items//", "notebooks//docs/"]) {
      expectCapabilityFailure(
        () =>
          canonicalizePolicyCapability({
            ...exactKvCapability,
            path,
          }),
        "policy-capability-malformed-path",
      );
    }
  });

  it("rejects capability inputs that would require authoring-time canonicalization", () => {
    for (const capability of [
      { ...exactKvCapability, actions: ["tinycloud.kv/list", "tinycloud.kv/get"] },
      { ...exactKvCapability, actions: ["tinycloud.kv/get", "tinycloud.kv/get"] },
      { ...exactKvCapability, path: "notebooks/cafe\u0301/notes" },
      { ...exactKvCapability, path: "notebooks/nb%2Dproject/docs" },
    ]) {
      expectCapabilityFailure(
        () => normalizePolicyCapability(capability),
        capability.path !== exactKvCapability.path
          ? "policy-capability-malformed-path"
          : "policy-capability-malformed-action",
      );
    }
  });

  it("rejects wildcard, prefix, empty, empty-segment, and traversal paths", () => {
    for (const path of [
      "items/*",
      "items/?",
      "items/**",
      "",
      "items//child",
      "items/./child",
      "items/../child",
    ]) {
      expectCapabilityFailure(
        () => normalizePolicyCapability({ ...exactKvCapability, path }),
        "policy-capability-malformed-path",
      );
    }
  });

  it("rejects aliases, wildcards, implied actions, unknown actions, and type mismatches", () => {
    for (const action of [
      "tinycloud.sql/select",
      "tinycloud.sql/*",
      "tinycloud.sql/admin",
      "tinycloud.sql/sudo",
    ]) {
      expectCapabilityFailure(
        () =>
          normalizePolicyCapability({
            ...sqlCapability,
            actions: [action],
          }),
        "policy-capability-malformed-action",
      );
    }
    expectCapabilityFailure(
      () => normalizePolicyCapability({ ...exactKvCapability, service: 1 }),
      "policy-capability-malformed-service",
    );
  });

  it("rejects non-native or loose caveat shapes", () => {
    expectCapabilityFailure(
      () => normalizePolicyCapability({ ...exactKvCapability, caveats: { extra: true } }),
      "policy-capability-malformed-caveats",
    );
    expectCapabilityFailure(
      () =>
        normalizePolicyCapability({
          ...sqlCapability,
          caveats: { ...sqlCapability.caveats, readOnly: false },
        }),
      "policy-capability-malformed-caveats",
    );
    expectCapabilityFailure(
      () =>
        normalizePolicyCapability({
          ...sqlCapability,
          caveats: { ...sqlCapability.caveats, extra: true },
        }),
      "policy-capability-malformed-caveats",
    );
  });

  it("rejects prototype-pollution keys safely", () => {
    const polluted = JSON.parse(
      '{"__proto__":{"service":"tinycloud.kv"},"service":"tinycloud.kv","space":"applications","path":"items/1","actions":["tinycloud.kv/get"]}',
    );
    expectCapabilityFailure(
      () => normalizePolicyCapability(polluted),
      "policy-capability-malformed",
    );
    expectCapabilityFailure(
      () =>
        normalizePolicyCapability({
          ...exactKvCapability,
          constructor: "tinycloud.kv",
        }),
      "policy-capability-malformed",
    );
    expect(Object.hasOwn(Object.prototype, "service")).toBe(false);
  });
});

describe("policy and bootstrap authoring", () => {
  it("authors and signs a Policy through the signed-object core", async () => {
    const signed = await createAndSignTranscriptSharePolicy(
      {
        ownerDid: OWNER_DID,
        signingKeyDid: suitesFixture.ed25519.policy_signer.did,
        createdAt: "2026-06-01T00:00:00Z",
        resourceType: "conversation",
        resourceId: "conv_456",
        permissionsCeiling: [sqlCapability],
        when: { subject: { did: SUBJECT_DID } },
        grant: baseGrant,
      },
      edSigner("policy_signer"),
    );
    expect(signed.schema).toBe(POLICY_SCHEMA);
    expect(signed.policyId).toBe(deriveSignedObjectMaterial({
      schema: POLICY_SCHEMA,
      ownerDid: OWNER_DID,
      signingKeyDid: suitesFixture.ed25519.policy_signer.did,
      createdAt: "2026-06-01T00:00:00Z",
      resource: {
        resourceType: "conversation",
        resourceId: "conv_456",
        permissionsCeiling: [normalizePolicyCapability(sqlCapability)],
      },
      when: { subject: { did: SUBJECT_DID } },
      grant: baseGrant,
    }).id);
  });

  it("refuses invented delegationMode and revocation strings before signing", async () => {
    const policy = concretePolicyVector();
    await expect(createAndSignPolicy(
      {
        ...policy.unsigned,
        grant: { ...(policy.unsigned.grant as object), delegationMode: "relay" },
      },
      edSigner("policy_signer"),
    )).rejects.toThrow();
    await expect(createAndSignPolicy(
      {
        ...policy.unsigned,
        grant: { ...(policy.unsigned.grant as object), revocation: "eventual" },
      },
      edSigner("policy_signer"),
    )).rejects.toThrow();

    await expectAuthoringFailure(
      () =>
        createAndSignTranscriptSharePolicy(
          {
            ownerDid: OWNER_DID,
            signingKeyDid: suitesFixture.ed25519.policy_signer.did,
            createdAt: "2026-06-01T00:00:00Z",
            resourceType: "conversation",
            resourceId: "conv_456",
            permissionsCeiling: [sqlCapability],
            when: { subject: { did: SUBJECT_DID } },
            grant: { ...baseGrant, delegationMode: "relay" },
          },
          edSigner("policy_signer"),
        ),
      "policy-authoring-malformed",
    );
    await expectAuthoringFailure(
      () =>
        createAndSignTranscriptSharePolicy(
          {
            ownerDid: OWNER_DID,
            signingKeyDid: suitesFixture.ed25519.policy_signer.did,
            createdAt: "2026-06-01T00:00:00Z",
            resourceType: "conversation",
            resourceId: "conv_456",
            permissionsCeiling: [sqlCapability],
            when: { subject: { did: SUBJECT_DID } },
            grant: { ...baseGrant, revocation: "eventual" },
          },
          edSigner("policy_signer"),
        ),
      "policy-authoring-malformed",
    );
  });

  it("refuses malformed capability paths through exported Policy signing", async () => {
    const policy = concretePolicyVector();
    for (const path of ["items/", "items//child", "items//"]) {
      await expect(createAndSignPolicy(
        {
          ...policy.unsigned,
          resource: {
            ...(policy.unsigned.resource as object),
            permissionsCeiling: [{ ...exactKvCapability, path }],
          },
        },
        edSigner("policy_signer"),
      )).rejects.toThrow();
    }
  });

  it("refuses to author malformed PolicyEngineRecord fields with typed errors", async () => {
    const baseRecord = {
      ownerDid: OWNER_DID,
      endpoint: "https://policy.example/resolve",
      audience: "did:web:requester.example",
      grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
      expiresAt: "2026-07-01T00:00:00Z",
    };
    expect(createUnsignedPolicyEngineRecord(baseRecord)).toMatchObject({
      schema: POLICY_ENGINE_RECORD_SCHEMA,
      supportedPolicyVersions: ["v0"],
      supportedEvidenceVerifiers: [W3C_VC_CREDENTIAL_VERIFIER],
    });
    await expectAuthoringFailure(
      () => createUnsignedPolicyEngineRecord({ ...baseRecord, expiresAt: "not-a-date" }),
      "policy-engine-record-date-invalid",
    );
    await expectAuthoringFailure(
      () =>
        createUnsignedPolicyEngineRecord({
          ...baseRecord,
          supportedPolicyVersions: ["v1"],
        }),
      "policy-authoring-malformed",
    );
    await expectAuthoringFailure(
      () =>
        createUnsignedPolicyEngineRecord({
          ...baseRecord,
          supportedEvidenceVerifiers: ["jwt/v1"],
        }),
      "policy-authoring-malformed",
    );
  });

  it("composes a bootstrap record that is not authority", async () => {
    const record = await createAndSignRequesterPolicyEngineRecord(
      {
        ownerDid: OWNER_DID,
        endpoint: "https://policy.example/resolve",
        audience: "did:web:requester.example",
        grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
        expiresAt: "2026-07-01T00:00:00Z",
      },
      edSigner("policy_signer"),
    );
    const bootstrap = composeTranscriptShareBootstrap({
      policyId: "pol_example",
      policyEngineRecord: record,
      resourceHint: { conversationId: "conv_456" },
    });
    expect(bootstrap.schema).toBe(TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA);
    expect(bootstrap.policyEngine).toEqual({
      endpoint: "https://policy.example/resolve",
      audience: "did:web:requester.example",
      supportedEvidenceVerifiers: [W3C_VC_CREDENTIAL_VERIFIER],
      signedRecord: record,
    });
  });

  it("rejects bootstrap unknown fields and polluted records with typed errors", async () => {
    const record = await createAndSignRequesterPolicyEngineRecord(
      {
        ownerDid: OWNER_DID,
        endpoint: "https://policy.example/resolve",
        audience: "did:web:requester.example",
        grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
        expiresAt: "2026-07-01T00:00:00Z",
      },
      edSigner("policy_signer"),
    );
    await expectAuthoringFailure(
      () =>
        composeTranscriptShareBootstrap({
          policyId: "pol_example",
          policyEngineRecord: { ...record, extra: true },
          resourceHint: { conversationId: "conv_456" },
        }),
      "transcript-share-bootstrap-malformed",
    );
    await expectAuthoringFailure(
      () =>
        composeTranscriptShareBootstrap(
          JSON.parse(
            JSON.stringify({
              policyId: "pol_example",
              policyEngineRecord: record,
              resourceHint: { conversationId: "conv_456" },
            }).replace('"policyId"', '"__proto__":{"policyId":"pol_bad"},"policyId"'),
          ),
        ),
      "transcript-share-bootstrap-malformed",
    );
  });
});

describe("requester-side PolicyEngineRecord verification", () => {
  async function signedEngineRecord() {
    return createAndSignRequesterPolicyEngineRecord(
      {
        ownerDid: OWNER_DID,
        endpoint: "https://policy.example/resolve",
        audience: "did:web:requester.example",
        grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
        expiresAt: "2026-07-01T00:00:00Z",
      },
      edSigner("policy_signer"),
    );
  }

  it("accepts a signed record that matches requester expectations", async () => {
    const record = await signedEngineRecord();
    await expect(
      verifyPolicyEngineRecordForRequester({
        signedRecord: record,
        ownerDid: OWNER_DID,
        audience: "did:web:requester.example",
        grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
        now: "2026-06-01T00:00:00Z",
      }),
    ).resolves.toMatchObject({ schema: POLICY_ENGINE_RECORD_SCHEMA });
  });

  it("returns distinct typed failures for absent, tampered, audience, expired, and owner mismatch", async () => {
    const record = await signedEngineRecord();
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          ownerDid: OWNER_DID,
          audience: "did:web:requester.example",
          grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
          now: "2026-06-01T00:00:00Z",
        } as never),
      "policy-engine-record-absent",
    );
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          signedRecord: {
            ...record,
            signature: { ...record.signature, value: tamperBase64Url(record.signature.value) },
          },
          ownerDid: OWNER_DID,
          audience: "did:web:requester.example",
          grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
          now: "2026-06-01T00:00:00Z",
        }),
      "policy-engine-record-signature-invalid",
    );
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          signedRecord: record,
          ownerDid: OWNER_DID,
          audience: "did:web:other.example",
          grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
          now: "2026-06-01T00:00:00Z",
        }),
      "policy-engine-record-audience-mismatch",
    );
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          signedRecord: record,
          ownerDid: OWNER_DID,
          audience: "did:web:requester.example",
          grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
          now: "2026-07-01T00:00:00Z",
        }),
      "policy-engine-record-expired",
    );
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          signedRecord: record,
          ownerDid: SUBJECT_DID,
          audience: "did:web:requester.example",
          grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
          now: "2026-06-01T00:00:00Z",
        }),
      "policy-engine-record-owner-mismatch",
    );
  });

  it("returns distinct typed failures for grant issuer, policy version, and evidence verifier mismatch", async () => {
    const record = await signedEngineRecord();
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          signedRecord: record,
          ownerDid: OWNER_DID,
          audience: "did:web:requester.example",
          grantIssuerDid: suitesFixture.ed25519.policy_signer.did,
          now: "2026-06-01T00:00:00Z",
        }),
      "policy-engine-record-grant-issuer-mismatch",
    );
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          signedRecord: record,
          ownerDid: OWNER_DID,
          audience: "did:web:requester.example",
          grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
          now: "2026-06-01T00:00:00Z",
          requiredPolicyVersion: "v1",
        }),
      "policy-engine-record-policy-version-unsupported",
    );
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          signedRecord: record,
          ownerDid: OWNER_DID,
          audience: "did:web:requester.example",
          grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
          now: "2026-06-01T00:00:00Z",
          requiredEvidenceVerifier: "jwt/v1",
        }),
      "policy-engine-record-evidence-verifier-unsupported",
    );
  });

  it("rejects malformed expiresAt before signature verification and type mismatches safely", async () => {
    const record = await signedEngineRecord();
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          signedRecord: {
            ...record,
            expiresAt: "not-a-date",
            signature: { ...record.signature, value: tamperBase64Url(record.signature.value) },
          },
          ownerDid: OWNER_DID,
          audience: "did:web:requester.example",
          grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
          now: "2026-06-01T00:00:00Z",
        }),
      "policy-engine-record-date-invalid",
    );
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester({
          signedRecord: { ...record, expiresAt: 123 },
          ownerDid: OWNER_DID,
          audience: "did:web:requester.example",
          grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
          now: "2026-06-01T00:00:00Z",
        }),
      "policy-engine-record-date-invalid",
    );
    await expectAuthoringFailure(
      () =>
        verifyPolicyEngineRecordForRequester(
          JSON.parse(
            JSON.stringify({
              signedRecord: record,
              ownerDid: OWNER_DID,
              audience: "did:web:requester.example",
              grantIssuerDid: suitesFixture.ed25519.grant_issuer.did,
              now: "2026-06-01T00:00:00Z",
            }).replace('"signedRecord"', '"__proto__":{"signedRecord":null},"signedRecord"'),
          ),
        ),
      "policy-authoring-malformed",
    );
  });
});
