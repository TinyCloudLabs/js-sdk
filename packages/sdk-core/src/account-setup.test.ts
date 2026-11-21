import { AccountSetupRequiredError } from "./account-setup";

describe("AccountSetupRequiredError", () => {
  it("keeps the previous human message as the default setupInstruction and Error.message", () => {
    const err = new AccountSetupRequiredError();
    const expected = "Finish setting up your TinyCloud account at https://home.tinycloud.xyz/ before signing in to this app.";
    expect(err.setupInstruction).toBe(expected);
    expect(err.message).toBe(expected);
    expect(err.code).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(err.setupUrl).toBe("https://home.tinycloud.xyz/");
    expect(err.name).toBe("AccountSetupRequiredError");
  });

  it("accepts host-supplied instruction copy without changing the error's fail-closed defaults", () => {
    const custom = "Finish setup at Home so this app can see your spaces.";
    const err = new AccountSetupRequiredError(custom);
    expect(err.setupInstruction).toBe(custom);
    expect(err.message).toBe(custom);
    // Nothing else moves — the code and the setup URL are the stable contract outside apps rely on.
    expect(err.code).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(err.setupUrl).toBe("https://home.tinycloud.xyz/");
  });

  it("logs its string form with no signature and no record payload (nothing to redact here)", () => {
    const err = new AccountSetupRequiredError("x");
    // The thrown object has only the fields enumerated above; a `${err}` interpolation names the class and
    // its message. It cannot leak a published record's bytes because there are none in this class.
    expect(`${err}`).toBe("AccountSetupRequiredError: x");
  });
});
