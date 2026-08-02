import type { SessionJwk, ShareEnvelope } from "./schema.js";

/**
 * Extract the embedded session JWK from a bearer-target envelope
 * (blueprint §2.1 "Embedded key" row). Node invocation with this key is
 * stage 3/4 — this is only the envelope side.
 *
 * Throws if the envelope's authorizationTarget is not `bearerKey`; callers
 * must switch on the discriminated union first (viewer spec §1).
 */
export function getBearerSessionJwk(envelope: ShareEnvelope): SessionJwk {
  const target = envelope.authorizationTarget;
  if (target.kind !== "bearerKey") {
    throw new TypeError(
      `envelope authorizationTarget is "${target.kind}", not "bearerKey"`,
    );
  }
  return target.sessionJwk;
}
