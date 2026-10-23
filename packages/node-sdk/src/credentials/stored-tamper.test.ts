import { expect, test } from "bun:test";
import { createPrivateKey, sign } from "node:crypto";
import { createStoredCredentialRecord, credentialRequirementDigest, CredentialError, type CredentialFlowDescriptor, type IssuerVerificationKey } from "@tinycloud/sdk-core";
import { acquireEmailProofWithIssuerKeys, createEd25519HolderSigner, createMemoryEmailProofPendingStore, emailProofRequirement, verifyStoredWithIssuerKeys, type StoredEmailProofInput, type StoredEmailProofRecord } from "./email-proof";
import { generateHolderKey, makeWitness } from "./test-support/witness-stub.mjs";

const ADDRESS = "reader@example.com";
const CODE = "12345678";
const fixture = await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
// Vector 1 is a different profile, so its digest differs from the pinned email descriptor.
const otherDescriptor = fixture.vectors[1]!.descriptor;

const holderKey = generateHolderKey();
const privateKey = createPrivateKey({ key: holderKey.jwk, format: "jwk" });
const HOLDER = createEd25519HolderSigner(holderKey.bare, async (bytes) => new Uint8Array(sign(null, bytes, privateKey)));

/**
 * Builds the stored record exactly as Courier's `StoredCredentialSource.store` does, from a real
 * issuance against the witness stub. The witness issuer keys are the only keys that accept it.
 */
async function issuedRecord(): Promise<{ input: StoredEmailProofInput; issuerKeys: readonly IssuerVerificationKey[] }> {
  const witness = makeWitness({ code: CODE });
  const acquisition = await acquireEmailProofWithIssuerKeys(
    { address: ADDRESS, holder: HOLDER, fetch: witness.fetch as typeof globalThis.fetch, pendingStore: createMemoryEmailProofPendingStore(), getCode: async () => CODE },
    witness.issuerKeys,
  );
  if (acquisition.status !== "issued") throw new Error("witness did not issue a credential");
  const requirement = emailProofRequirement(ADDRESS);
  const base = await createStoredCredentialRecord({
    verified: acquisition.result.verified,
    ownerDid: HOLDER.did,
    requirement,
    requirementDigest: await credentialRequirementDigest(requirement),
    storedAt: new Date().toISOString(),
  });
  const record: StoredEmailProofRecord = { ...base, subjectDid: acquisition.result.envelope.subjectDid, descriptor: acquisition.result.descriptor };
  return { input: { record, requirement, holderDid: HOLDER.did, now: new Date() }, issuerKeys: witness.issuerKeys };
}

test("control: the untampered stored record verifies", async () => {
  const { input, issuerKeys } = await issuedRecord();
  const verified = await verifyStoredWithIssuerKeys(input, issuerKeys);
  expect(verified.claims.email).toBe(ADDRESS);
});

/** `expectedCode` pins the refusal code where the verifier's classification is correct. Omitted means only the error class is pinned. */
type Tamper = { readonly name: string; readonly mutate: (record: StoredEmailProofRecord) => StoredEmailProofRecord; readonly expectedCode?: string };

// Each row is refused by a different check. Rows outside the signed envelope (ownerDid, credentialDigest,
// requirementDigest, recordId) are caught only by the post-verify checks in verifyStoredWithIssuerKeys.
const tampers: readonly Tamper[] = [
  { name: "subjectDid is changed", expectedCode: "HOLDER_MISMATCH", mutate: (r) => ({ ...r, subjectDid: "did:example:someone-else" }) },
  // The verifier's envelope-identity check throws HOLDER_MISMATCH for profile mismatches too (verification.ts line 30),
  // so the code is not pinned here. The refusal itself is what this row proves.
  { name: "profile is changed", mutate: (r) => ({ ...r, profile: "tinycloud.email-domain-proof/v1" as StoredEmailProofRecord["profile"] }) },
  { name: "ownerDid is changed (outside the signed envelope)", expectedCode: "HOLDER_MISMATCH", mutate: (r) => ({ ...r, ownerDid: "did:example:someone-else" }) },
  { name: "descriptor content is edited (digest no longer equals the pin)", expectedCode: "VERIFICATION_FAILED", mutate: (r) => ({ ...r, descriptor: { ...r.descriptor, lifecycle: { ...r.descriptor.lifecycle, tampered: true } } as unknown as CredentialFlowDescriptor }) },
  { name: "descriptor.protocol is changed", expectedCode: "VERIFICATION_FAILED", mutate: (r) => ({ ...r, descriptor: { ...r.descriptor, protocol: "tinycloud.credentials/other/v1" } as CredentialFlowDescriptor }) },
  { name: "descriptor.format.vct is changed", expectedCode: "VERIFICATION_FAILED", mutate: (r) => ({ ...r, descriptor: { ...r.descriptor, format: { ...r.descriptor.format, vct: "opencredentials.other/v1" } } as CredentialFlowDescriptor }) },
  { name: "a different profile's descriptor is swapped in (snapshot swap)", expectedCode: "VERIFICATION_FAILED", mutate: (r) => ({ ...r, descriptor: otherDescriptor }) },
  { name: "expiresAt is moved later than the SD-JWT exp", expectedCode: "REQUEST_EXPIRED", mutate: (r) => ({ ...r, expiresAt: new Date(Date.parse(r.expiresAt) + 3600_000).toISOString() }) },
  { name: "one byte of the SD-JWT header is flipped", expectedCode: "VERIFICATION_FAILED", mutate: (r) => {
    const i = 10;
    const flipped = r.credential[i] === "A" ? "B" : "A";
    return { ...r, credential: r.credential.slice(0, i) + flipped + r.credential.slice(i + 1) };
  } },
  { name: "one byte of the SD-JWT signature is flipped", expectedCode: "VERIFICATION_FAILED", mutate: (r) => {
    // The signature is the third '.'-separated segment of the JWT, before the first '~'.
    const jwt = r.credential.split("~")[0]!;
    const i = jwt.lastIndexOf(".") + 5;
    const flipped = r.credential[i] === "A" ? "B" : "A";
    return { ...r, credential: r.credential.slice(0, i) + flipped + r.credential.slice(i + 1) };
  } },
  { name: "credentialDigest is changed (outside the signed envelope)", expectedCode: "VERIFICATION_FAILED", mutate: (r) => ({ ...r, credentialDigest: "f".repeat(43) }) },
  { name: "requirementDigest is changed (outside the signed envelope)", expectedCode: "VERIFICATION_FAILED", mutate: (r) => ({ ...r, requirementDigest: "f".repeat(43) }) },
  { name: "recordId is changed (outside the signed envelope)", expectedCode: "VERIFICATION_FAILED", mutate: (r) => ({ ...r, recordId: "f".repeat(43) }) },
];

for (const tamper of tampers) {
  test(`refuses a stored record whose ${tamper.name}`, async () => {
    const { input, issuerKeys } = await issuedRecord();
    const tampered: StoredEmailProofInput = { ...input, record: tamper.mutate(input.record) };
    const error: unknown = await verifyStoredWithIssuerKeys(tampered, issuerKeys).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialError);
    if (tamper.expectedCode !== undefined) expect((error as CredentialError).code).toBe(tamper.expectedCode);
    // The refusal must not echo the credential it refused.
    expect(String((error as Error).message)).not.toContain(input.record.credential.slice(0, 40));
  });
}
