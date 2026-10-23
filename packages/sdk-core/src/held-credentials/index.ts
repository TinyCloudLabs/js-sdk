// Held-credential verifier. Use one build (ESM or CJS) of this entry point per process.
export { HeldCredentialError, type HeldCredentialErrorCode } from "./errors";
export { verifyHeldPresentation, type AcceptedIssuer, type AcceptedProfile, type HeldPresentation, type VerifiedHeldCredential, type VerifyHeldPresentationOptions } from "./verify";
export { ISSUER_SET_FORMAT, IssuerSet, parseIssuerSet, type IssuerEntry, type IssuerSetOptions } from "./issuer-set";
export { ACCOUNT_BINDING_DOMAIN, DEFAULT_ROWS, EMAIL_HELD_ROW, HELD_EMAIL_TTL_SECONDS, ORG_MEMBERSHIP_FREE_ROW, ORG_MEMBERSHIP_ROW, ORG_MEMBERSHIP_ROWS, type ProfileRow } from "./rows";
export { InMemoryNonceStore, randomNonce, type NonceStore } from "./nonce-store";
export { PRESENTATION_STATEMENT, SD_HASH_RESOURCE_PREFIX, assertValidAudience } from "./siwe";
export { parsePkhDid, pkhPrincipalsEqual, registryKey, toChecksumAddress } from "./did";
export { normaliseEmail } from "./email";
export { verifyHeldEmailCredential, selectDisclosures, sdHash, type HeldEmailCredentialOptions } from "./credential";
