import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { verifyMessage, type Hex } from "viem";

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
  test("accepts mixed-case EIP-191 signature hex after lowercase normalization", async () => {
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
    expect(object?.domain).toBe("xyz.tinycloud.policy/holder-enrollment/v0");

    expect(check.signature_hex).toMatch(/[A-F]/);
    expect(check.signature_hex).toMatch(/^[0-9A-Fa-f]+$/);

    const normalizedSignatureHex = check.signature_hex.toLowerCase();
    expect(normalizedSignatureHex).toBe(check.normalized_signature_hex);

    const signatureBytes = Buffer.from(normalizedSignatureHex, "hex");
    expect(signatureBytes).toHaveLength(65);

    const signatureValue = signatureBytes.toString("base64url");
    expect(signatureValue).toBe(object?.signature.value);

    const signerAddress = pkhDidAddress(object!.signature.signerDid);
    const accepted = await verifyMessage({
      address: signerAddress,
      message: { raw: `0x${object!.digest_hex}` as Hex },
      signature: `0x${normalizedSignatureHex}` as Hex,
    });

    expect(accepted).toBe(true);
  });
});

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
  unsigned_jcs_utf8_hex: string;
  digest_hex: string;
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

function pkhDidAddress(did: string): Hex {
  const address = did.split(":").at(-1);
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`expected did:pkh signer address, got ${did}`);
  }
  return address as Hex;
}
