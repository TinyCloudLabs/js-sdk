import { AccountSetupRequiredError, FINISH_SETUP_REGISTRY_INTENT } from "./account-setup";

describe("AccountSetupRequiredError", () => {
  it("defaults setupUrl to Home with finish-setup=registry intent (TC-3547)", () => {
    const err = new AccountSetupRequiredError();
    expect(err.setupUrl).toBe(`https://home.tinycloud.xyz/?${FINISH_SETUP_REGISTRY_INTENT}`);
    expect(FINISH_SETUP_REGISTRY_INTENT).toBe("finish-setup=registry");
  });

  it("default setupInstruction and Error.message name the same URL as setupUrl", () => {
    const err = new AccountSetupRequiredError();
    expect(err.setupInstruction).toContain(err.setupUrl);
    expect(err.message).toContain(err.setupUrl);
    expect(err.code).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(err.name).toBe("AccountSetupRequiredError");
  });

  it("accepts host-supplied instruction copy without changing the error's fail-closed defaults", () => {
    const custom = "Finish setup at Home so this app can see your spaces.";
    const err = new AccountSetupRequiredError(custom);
    expect(err.setupInstruction).toBe(custom);
    expect(err.message).toBe(custom);
    // Nothing else moves — the code and the setup URL (with intent) are the stable contract.
    expect(err.code).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(err.setupUrl).toBe(`https://home.tinycloud.xyz/?${FINISH_SETUP_REGISTRY_INTENT}`);
  });

  it("logs its string form with no signature and no record payload (nothing to redact here)", () => {
    const err = new AccountSetupRequiredError("x");
    // The thrown object has only the fields enumerated above; a `${err}` interpolation names the class and
    // its message. It cannot leak a published record's bytes because there are none in this class.
    expect(`${err}`).toBe("AccountSetupRequiredError: x");
  });
});
