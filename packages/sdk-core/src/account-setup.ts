/** A third-party app cannot provision the owner's account as part of its grant. */
export class AccountSetupRequiredError extends Error {
  readonly code = "ACCOUNT_SETUP_REQUIRED";
  readonly setupUrl = "https://home.tinycloud.xyz/";
  constructor() {
    super("Finish setting up your TinyCloud account at https://home.tinycloud.xyz/ before signing in to this app.");
    this.name = "AccountSetupRequiredError";
  }
}
