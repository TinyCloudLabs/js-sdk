// Held-credential verifier. Import ONE build (ESM or CJS) of this entry point per process: an
// IssuerSet created by the other build is refused as `bad-config`.
export { HeldCredentialError, type HeldCredentialErrorCode } from "./errors";
export { verifyHeldPresentation, type AcceptedIssuer, type AcceptedProfile, type HeldPresentation, type VerifiedHeldCredential, type VerifyHeldPresentationOptions } from "./verify";
export { ISSUER_SET_FORMAT, IssuerSet, parseIssuerSet, type IssuerEntry, type IssuerSetOptions } from "./issuer-set";
export { ACCOUNT_BINDING_DOMAIN, DEFAULT_ROWS, EMAIL_HELD_ROW, HELD_EMAIL_TTL_SECONDS, type ProfileRow } from "./rows";
export { InMemoryNonceStore, randomNonce, type NonceStore } from "./nonce-store";
export { PRESENTATION_STATEMENT, SD_HASH_RESOURCE_PREFIX } from "./siwe";
export { parsePkhDid, pkhPrincipalsEqual, registryKey, toChecksumAddress } from "./did";
export { normaliseEmail } from "./email";
