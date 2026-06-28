export {
  createServerIdentity,
  deriveDstackPrivateKey,
  isTinyCloudSessionError,
  serverDidForPrivateKey,
  withSessionRefresh,
  type CreateServerIdentityOptions,
  type DeriveDstackPrivateKeyOptions,
  type DstackKeyClient,
  type ServerIdentity,
} from "./identity.js";

export {
  createServerDelegateClient,
  parseDelegation,
  parseEncryptedEnvelope,
  parseSecretPayload,
  readDelegatedSecret,
  type CreateServerDelegateClientOptions,
  type DelegationInput,
  type ServerDelegateClient,
} from "./delegated-secrets.js";

export {
  NonceStore,
  ServerAuthError,
  createSiweSession,
  issueSessionToken,
  verifySessionToken,
  verifySiweMessage,
  type CreateSiweSessionOptions,
  type SessionClaims,
  type SessionToken,
  type VerifiedSiwe,
} from "./siwe-session.js";
