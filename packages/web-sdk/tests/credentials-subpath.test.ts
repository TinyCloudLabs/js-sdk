import { expect, test } from "bun:test";
import { CredentialError, type CredentialRequirement } from "@tinycloud/sdk-core";
import { verifyStoredEmailProof, type StoredEmailProofInput, type StoredEmailProofRecord } from "../src/credentials-subpath";

test("the credentials subpath exposes the offline verifier and refuses a record that is not the pinned descriptor", async () => {
  // The record carries a descriptor digest that is not the pin, so the verifier must refuse before any
  // signature or claim work. The other fields are placeholders the refusal never reads.
  const input: StoredEmailProofInput = {
    record: { descriptorDigest: "sha256:not-the-pinned-digest" } as unknown as StoredEmailProofRecord,
    requirement: {} as unknown as CredentialRequirement,
    holderDid: "did:example:holder",
    now: new Date(),
  };
  const error: unknown = await verifyStoredEmailProof(input).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CredentialError);
  expect((error as CredentialError).code).toBe("VERIFICATION_FAILED");
});
