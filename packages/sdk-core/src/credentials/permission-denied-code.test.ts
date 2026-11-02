import { describe, expect, test } from "bun:test";
import { CREDENTIAL_ERROR_CODES, CredentialError } from "./errors";

// TC-1454: a held-credential storage call the app session may not make is PERMISSION_DENIED, an additive CredentialError code. It is not
// recoverable by retrying the same call: the app needs a different grant, so a host that retries recoverable errors must not loop on it.
describe("CredentialError PERMISSION_DENIED", () => {
  test("is in the public code list, once, and OFFLINE is still a recoverable, different code", () => {
    expect(CREDENTIAL_ERROR_CODES.filter((code) => code === "PERMISSION_DENIED")).toHaveLength(1);
    expect(new CredentialError("OFFLINE", "x").recoverable).toBe(true);
  });

  test("is not recoverable by default, and a caller may still say otherwise", () => {
    const error = new CredentialError("PERMISSION_DENIED", "This app can't read held credentials: the session may lack kv get and list on v1/held/ (skipPrefix), or may need to sign in again.");
    expect([error.code, error.recoverable, error.name]).toEqual(["PERMISSION_DENIED", false, "CredentialError"]);
    expect(new CredentialError("PERMISSION_DENIED", "x", { recoverable: true }).recoverable).toBe(true);
  });
});
