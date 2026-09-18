import { describe, expect, test } from "bun:test";
import { credentialRequirementDigest } from "../credentials";
import { validatePolicyCredentialRequirementV1 } from "./credential-admission";

describe("TC-470 policy credential contract", () => {
  test("matches the canonical policy-engine requirement projection vector", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/credential-requirement.json`,
    ).json()) as any;

    expect(await credentialRequirementDigest(vector.sdkRequirement)).toBe(
      vector.requirementDigest,
    );
    expect(validatePolicyCredentialRequirementV1(vector.policyProjection)).toEqual(
      vector.policyProjection,
    );
    expect(JSON.stringify(vector.policyProjection)).not.toContain(
      vector.sdkRequirement.claims.email,
    );
  });
});
