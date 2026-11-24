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

/** `put` could not learn whether the node has per-secret keys: nothing was asked, signed or saved, and a retry may work (TC-3801). */
export const NAMED_KEYS_CHECK_FAILED = "NAMED_KEYS_CHECK_FAILED";

/** The words a person sees for {@link NAMED_KEYS_CHECK_FAILED}. */
export const NAMED_KEYS_CHECK_FAILED_MESSAGE =
  "Couldn't reach this TinyCloud node to check that it can save secrets. Nothing was saved. Try again in a moment.";

/**
 * What a secrets `put` does with the node's answer to "has per-secret keys?": a refusal for `false` (unsupported)
 * and for `undefined` (could not be checked, so it fails closed: a put on such a node would otherwise ask the
 * wallet to sign first), `undefined` when the node has them.
 */
export function namedKeysPutRefusal(supported: boolean | undefined): Result<never, ServiceError> | undefined {
  if (supported === true) return undefined;
  if (supported === false) return namedKeysUnsupportedResult();
  return {
    ok: false,
    error: { code: NAMED_KEYS_CHECK_FAILED, service: "secrets", message: NAMED_KEYS_CHECK_FAILED_MESSAGE, meta: { retryable: true } },
  };
}
