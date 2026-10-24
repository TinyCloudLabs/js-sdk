/**
 * Links: typed, issuer-signed records stored by the links API, and the `#v=4`
 * link grammar that points at them. Published as the
 * `@tinycloud/share-envelope/links` subpath. It uses only WebCrypto
 * (`globalThis.crypto`), `fetch` and the package's own primitives, so it runs
 * unchanged in browsers and in Node.
 */
export {
  createLink,
  deleteLink,
  prepareLinkRecord,
  resolveLink,
  type CreateLinkInput,
  type CreatedLink,
  type LinkTransportOptions,
  type PrepareLinkRecordInput,
  type PreparedLinkRecord,
  type ResolveLinkInput,
  type ResolvedLink,
  type SealedLinkBody,
} from "./api.js";
export {
  DEFAULT_LINKS_API_ORIGIN,
  FULL_LINK_PATH,
  LINK_DELETE_DOMAIN,
  LINK_HEADER_DOMAIN,
  LINK_ID_PATTERN,
  MAX_LINK_BODY_BYTES,
  MAX_LINK_REQUEST_BYTES,
  LINK_MAX_RECORD_HEADER_BYTES,
  LINK_MIN_BODY_BYTES,
  LINK_MIN_LIFE_SECONDS,
  LINK_TYPES,
  LINK_SEAL_OVERHEAD_BYTES,
  LINK_TYPE_SPECS,
  LINK_WINDOW_SECONDS,
  type LinkType,
  type LinkTypeSpec,
} from "./constants.js";
export { DEFAULT_SHARE_ORIGINS, assertDidKeySignature, redactLink, shortShareLinkCid } from "./delivery.js";
export { ed25519KeyProblem, verifyEd25519Strict, type Ed25519KeyProblem } from "./ed25519-strict.js";
export { LinkError, isLinkError, type LinkErrorCode } from "./errors.js";
export {
  LINK_FRAGMENT_VERSION,
  buildFullLink,
  buildShortLink,
  normalizeLinkId,
  parseLink,
  type ParsedFullLink,
  type ParsedLink,
  type ParsedShortLink,
} from "./grammar.js";
export {
  checkLinkBody,
  checkLinkHeaderLife,
  linkDeleteRequestV1Schema,
  linkHeaderV1Schema,
  linkIssuerPublicKey,
  linkSignatureV1Schema,
  linkSigningBytes,
  linkSigningDigest,
  linkTypeSchema,
  parseLinkTimestamp,
  randomLinkNonce,
  signDelete,
  signHeader,
  validateLinkDeleteRequest,
  validateLinkHeader,
  verifyDelete,
  verifyHeader,
  type LinkDeleteRequestV1,
  type LinkHeaderV1,
  type LinkIssuerMode,
  type LinkRecord,
  type LinkSignatureV1,
} from "./header.js";
export { checkLinkRecord, openLinkRecord, type CheckedLinkRecord, type LinkBodyValidator, type OpenedLink } from "./record.js";
export { signerFromJwk, signerFromSeed, type Ed25519PrivateJwk, type LinkSigner } from "./signer.js";
