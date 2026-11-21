/** A third-party app cannot provision the owner's account as part of its grant. */
export class AccountSetupRequiredError extends Error {
  readonly code = "ACCOUNT_SETUP_REQUIRED";
  readonly setupUrl = "https://home.tinycloud.xyz/";
  /**
   * Optional instruction copy the host app renders beside the setup link. Hosts that
   * surface this error to the person (e.g. TinyChat) replace it with words from their
   * own copy owner, so Monica-level edits do not require an SDK release. The default
   * stays byte-identical to what the error already said.
   */
  readonly setupInstruction: string;
  constructor(setupInstruction = "Finish setting up your TinyCloud account at https://home.tinycloud.xyz/ before signing in to this app.") {
    super(setupInstruction);
    this.name = "AccountSetupRequiredError";
    this.setupInstruction = setupInstruction;
  }
}
