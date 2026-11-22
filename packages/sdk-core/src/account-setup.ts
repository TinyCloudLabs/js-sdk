/** Query-string intent appended to `AccountSetupRequiredError.setupUrl`. TinyCloud One and
 * Home read it to open the finish-setup step that publishes the owner's registry record,
 * the only place that record is signed. */
export const FINISH_SETUP_REGISTRY_INTENT = "finish-setup=registry" as const;

/** Where the person finishes setting up their account. TinyCloud One is the product name
 *  at this URL; `home.tinycloud.xyz` 302s here with the query preserved. */
const SETUP_URL = `https://tinycloud.one/?${FINISH_SETUP_REGISTRY_INTENT}` as const;

/** A third-party app cannot provision the owner's account as part of its grant. */
export class AccountSetupRequiredError extends Error {
  readonly code = "ACCOUNT_SETUP_REQUIRED";
  /** URL the owner is sent to; carries `finish-setup=registry` so TinyCloud One or Home
   *  opens its finish-setup step, which publishes the owner's registry record. */
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
