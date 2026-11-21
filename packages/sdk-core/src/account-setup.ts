/** Query-string intent appended to `AccountSetupRequiredError.setupUrl`. The first-party
 * host uses this to open the registry publish consent even after a previous decline,
 * closing the dead end where a dismissed banner + no Settings entry leaves an owner no way
 * to retry. See TC-3547. */
export const FINISH_SETUP_REGISTRY_INTENT = "finish-setup=registry" as const;

/** Where the person finishes setting up their account. TinyCloud One is the product name
 *  at this URL; `home.tinycloud.xyz` 302s here with the query preserved. */
const SETUP_URL = `https://tinycloud.one/?${FINISH_SETUP_REGISTRY_INTENT}` as const;

/** A third-party app cannot provision the owner's account as part of its grant. */
export class AccountSetupRequiredError extends Error {
  readonly code = "ACCOUNT_SETUP_REQUIRED";
  /** URL the owner is sent to; carries `finish-setup=registry` so the first-party host
   *  opens the publish consent regardless of a previously-dismissed banner (TC-3547). */
  readonly setupUrl = SETUP_URL;
  /** Optional instruction copy the host app renders beside the setup link. Hosts that
   *  surface this error to the person (e.g. TinyChat) replace it with words from their
   *  own copy owner, so wording edits do not require an SDK release. */
  readonly setupInstruction: string;
  constructor(setupInstruction = `Finish setting up your TinyCloud account in TinyCloud One, then sign in to this app again: ${SETUP_URL}`) {
    super(setupInstruction);
    this.name = "AccountSetupRequiredError";
    this.setupInstruction = setupInstruction;
  }
}
