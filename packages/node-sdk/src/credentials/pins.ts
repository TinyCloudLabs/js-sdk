import { ACCOUNT_HOLDER_BINDING_DOMAIN } from "@tinycloud/sdk-core";

/** Production pins. Credentials verify only against these values. Tests pin them literally. */
export const EMAIL_PROOF_PINS = Object.freeze({
  witnessOrigin: "https://witness.credentials.org",
  issuerDid: "did:web:issuer.credentials.org",
  issuerKid: "did:web:issuer.credentials.org#controller",
  issuerX: "eEJI4xEobto4HtQ7Pg9R1vBOwcpfGRTlXDG5QfqLnGQ",
  descriptorDigest: "1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0",
} as const);

/**
 * The static fields of the held account binding (contract A2.4). One frozen object: the create request body, the binding checks
 * the SDK runs on the witness's binding (S11 (a)) and the account signer's guard all read these values, so the three cannot drift.
 * The per-request fields (`requestId`, `challengeNonce`, the digests of the request, `jti`, `issuedAt`, `expiresAt`) and the
 * signer's own `holderDid` are not static and are not here.
 */
export const HELD_ACCOUNT_BINDING_PINS = Object.freeze({
  type: ACCOUNT_HOLDER_BINDING_DOMAIN,
  protocol: "tinycloud.credentials/acquisition/v1",
  profile: "tinycloud.email-held/v1",
  profileVersion: 1,
  descriptorDigest: "dc3_DuvzipXwYkTfjKqTaK1c3VS0YSPnaBsYSQriC0w",
  issuer: EMAIL_PROOF_PINS.issuerDid,
  issuerKid: EMAIL_PROOF_PINS.issuerKid,
  audience: "tinycloud://credentials",
  openerOrigin: "https://localhost",
  completionOrigin: "https://localhost",
  completionContext: "sdk-acquisition",
  credentialLifetimeSeconds: 31_536_000,
} as const);
