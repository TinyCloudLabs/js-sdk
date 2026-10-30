// Browser-safe credential driver. Imports only @tinycloud/sdk-core and the
// node-sdk core type surface; no Node built-ins may enter this graph.
export * from "./types";
export { interpretCredentialFlow, mailboxSubject } from "./interpreter";
export { OpenCredentialsHttpTransport } from "./transport";
export {
  acquireEmailProof,
  completeEmailProof,
  createEd25519HolderSigner,
  createMemoryEmailProofPendingStore,
  DEFAULT_EMAIL_PROOF_PROFILE,
  EMAIL_PROOF_CREDENTIAL_TYPE,
  EMAIL_PROOF_PINS,
  HELD_ACCOUNT_BINDING_PINS,
  EMAIL_PROOF_PENDING_MAX_MS,
  EmailProofError,
  isTicketEmailProofResult,
  emailProofRequirement,
  verifyStoredEmailProof,
  requestEmailProofCode,
} from "./email-proof";
export type {
  EmailProofAcquireInput,
  EmailProofAcquisition,
  EmailProofErrorCode,
  EmailProofOptions,
  EmailProofPending,
  EmailProofPendingStore,
  EmailProofProfileId,
  EmailProofRequestInput,
  EmailProofResult,
  StoredEmailProofRecord,
  StoredEmailProofInput,
  EmailProofStep,
  HolderAlgorithm,
  HolderSigner,
} from "./email-proof";
