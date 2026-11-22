import type { Result, ServiceError } from "../types";

/** `put` on a node that does not list `encryption-named-keys-v1`: nothing is saved (TC-3801). */
export const NAMED_KEYS_UNSUPPORTED = "NAMED_KEYS_UNSUPPORTED";

/** The words a person sees for {@link NAMED_KEYS_UNSUPPORTED} (Monica, S1k). The CLI prints them too. */
export const NAMED_KEYS_UNSUPPORTED_MESSAGE =
  "This TinyCloud node can't save secrets, because it doesn't support per-secret keys (encryption-named-keys-v1). " +
  "Nothing was saved. Secrets already on it can be read, listed and deleted. " +
  "To save secrets here, whoever runs the node needs to upgrade it.";

/** The refusal a secrets `put` returns before any signature or write. */
export function namedKeysUnsupportedResult(): Result<never, ServiceError> {
  return {
    ok: false,
    error: { code: NAMED_KEYS_UNSUPPORTED, service: "secrets", message: NAMED_KEYS_UNSUPPORTED_MESSAGE },
  };
}
