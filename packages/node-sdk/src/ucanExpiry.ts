/**
 * The technical limit on a token signed by the session key (`delegateTo`, agent
 * and share delegations): 2255-06-05T23:47:34Z, floored to the second. The
 * WASM token builder keeps UCAN timestamps exact to the microsecond in a
 * double, which stops there (`Out of valid microsecond-precision range of
 * NumericDate`). A session itself can still be signed to 9999-12-31, the
 * wallet-signed limit in `@tinycloud/sdk-core` (`MAX_SIWE_EXPIRY_MS`).
 *
 * This lives in node-sdk, not sdk-core, because only `NodeWasmBindings`
 * mints these tokens; the browser bundle does not carry it.
 *
 * @packageDocumentation
 */

export const MAX_UCAN_EXPIRY_MS = 9007199254000;

/**
 * Why `expiresAt` cannot be written into a session-key token, or `null` when
 * it can. An invalid Date, NaN and Infinity are refused too.
 */
export function ucanExpiryRefusal(expiresAt: Date | number): string | null {
  // `NaN` (an invalid Date) and `Infinity` fail the comparison too, so they are refused with the same message.
  return Number(expiresAt) <= MAX_UCAN_EXPIRY_MS
    ? null
    : "expiry is not a valid date or is later than 2255-06-05, the latest date an agent or share delegation can carry (UCAN limit); the session itself can be signed to 9999-12-31; choose an earlier expiry";
}

/** Throws the {@link ucanExpiryRefusal} message as an `Error`. */
export function assertUcanExpiryWithinLimit(expiresAt: Date | number): void {
  const refusal = ucanExpiryRefusal(expiresAt);
  if (refusal) throw new Error(refusal);
}
