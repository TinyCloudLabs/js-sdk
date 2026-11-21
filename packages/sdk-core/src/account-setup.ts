/** Query-string intent appended to `AccountSetupRequiredError.setupUrl`. The first-party
 * host (Home) uses this to open the registry publish consent even after a previous decline,
 * closing the dead end where a dismissed banner + no Settings entry leaves an owner no way
 * to retry when the third-party wall points them back at Home. See TC-3547. */
export const FINISH_SETUP_REGISTRY_INTENT = "finish-setup=registry" as const;

/** A third-party app cannot provision the owner's account as part of its grant. */
export class AccountSetupRequiredError extends Error {
  readonly code = "ACCOUNT_SETUP_REQUIRED";
  /** Home URL the owner is sent to. Carries `finish-setup=registry` so the first-party
   *  host opens the publish consent regardless of a previously-dismissed banner (TC-3547). */
  readonly setupUrl = `https://home.tinycloud.xyz/?${FINISH_SETUP_REGISTRY_INTENT}`;
  /**
   * Optional instruction copy the host app renders beside the setup link. Hosts that
   * surface this error to the person (e.g. TinyChat) replace it with words from their
   * own copy owner, so Monica-level edits do not require an SDK release. The default
   * matches the previous human message word-for-word except for the new query intent on
   * the URL, which is backward-safe (browsers accept unknown query params).
   */
  readonly setupInstruction: string;
  constructor(setupInstruction = `Finish setting up your TinyCloud account at https://home.tinycloud.xyz/?${FINISH_SETUP_REGISTRY_INTENT} before signing in to this app.`) {
    super(setupInstruction);
    this.name = "AccountSetupRequiredError";
    this.setupInstruction = setupInstruction;
  }
}
