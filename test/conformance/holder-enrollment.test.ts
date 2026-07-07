import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

// Policy-engine integration vector pin:
// 0713e57454920630aec7c8447fd629787794a81e
// Source: test-vectors/signed-object-profile/objects.json
// Spec citations: Multi-Repo Execution Model / Vector consumption and Two-Repo Contract Proof.
const VECTOR_COMMIT_SHA = "0713e57454920630aec7c8447fd629787794a81e";
const OBJECTS_FIXTURE = new URL(
  "./fixtures/holder-enrollment/objects.json",
  import.meta.url,
);

describe("HolderEnrollment conformance vectors", () => {
  test("accepts mixed-case EIP-191 signature hex after lowercase normalization", () => {
    const fixture = loadObjectsFixture();
    expect(VECTOR_COMMIT_SHA).toBe("0713e57454920630aec7c8447fd629787794a81e");

    const checks = fixture.signatureHexNormalizationChecks;
    expect(checks).toHaveLength(1);

    const check = checks[0];
    expect(check.name).toBe("holder-enrollment-eip191-mixed-case-signature-hex-normalizes");
    expect(check.expected).toBe("accept");
    expect(check.normalization).toBe("lowercase-hex-before-byte-decode");
    expect(check.object_type).toBe("HolderEnrollment");

    const object = fixture.objects.find(
      (candidate) =>
        candidate.object_type === check.object_type && candidate.id === check.object_id,
    );
    expect(object).toBeDefined();
    expect(object?.signature.suite).toBe(check.suite);
    expect(object?.signature.signerDid).toBe(object?.unsigned.signingKeyDid);

    const accepted = acceptNormalizedEnrollmentSignature(check, object!);

    expect(accepted.object_type).toBe("HolderEnrollment");
    expect(accepted.signature.value).toBe(object?.signature.value);
    expect(accepted.signature.signerDid).toBe(object?.signature.signerDid);
    expect(accepted.enrollmentId).toBe(object?.id);
  });
});

function acceptNormalizedEnrollmentSignature(
  check: SignatureHexNormalizationCheck,
  object: SignedObjectVector,
) {
  if (object.object_type !== "HolderEnrollment") {
    throw new Error(`expected HolderEnrollment, got ${object.object_type}`);
  }
  if (check.expected !== "accept") {
    throw new Error(`unexpected vector disposition: ${check.expected}`);
  }

  expect(check.signature_hex).toMatch(/[A-F]/);
  expect(check.signature_hex).toMatch(/^[0-9A-Fa-f]+$/);

  const normalizedSignatureHex = normalizeSignatureHex(check.signature_hex);
  expect(normalizedSignatureHex).toBe(check.normalized_signature_hex);

  const signatureBytes = Buffer.from(normalizedSignatureHex, "hex");
  expect(signatureBytes).toHaveLength(65);

  const signatureValue = base64UrlNoPad(signatureBytes);
  expect(signatureValue).toBe(object.signature.value);

  return {
    ...object.unsigned,
    [object.id_field]: object.id,
    object_type: object.object_type,
    signature: {
      suite: check.suite,
      signerDid: object.signature.signerDid,
      value: signatureValue,
    },
  };
}

function normalizeSignatureHex(value: string): string {
  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(hex)) {
    throw new Error("signature hex must contain full bytes");
  }
  return hex.toLowerCase();
}

function base64UrlNoPad(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function loadObjectsFixture(): ObjectsFixture {
  return JSON.parse(readFileSync(OBJECTS_FIXTURE, "utf8")) as ObjectsFixture;
}

interface ObjectsFixture {
  objects: SignedObjectVector[];
  signatureHexNormalizationChecks: SignatureHexNormalizationCheck[];
}

interface SignatureHexNormalizationCheck {
  name: string;
  object_type: string;
  object_id: string;
  suite: string;
  signature_hex: string;
  normalized_signature_hex: string;
  normalization: string;
  expected: string;
}

interface SignedObjectVector {
  object_type: string;
  id_field: string;
  id: string;
  domain: string;
  unsigned: {
    signingKeyDid?: string;
    [key: string]: unknown;
  };
  signature: {
    suite: string;
    signerDid: string;
    value: string;
  };
}
