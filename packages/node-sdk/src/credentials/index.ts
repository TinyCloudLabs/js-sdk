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
  EMAIL_PROOF_PENDING_MAX_MS,
  EmailProofError,
  emailProofRequirement,
  requestEmailProofCode,
} from "./email-proof";
export { EMAIL_PROOF_PENDING_MAX_MS, restoreEmailProofPending } from "./email-proof";
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
  EmailProofStep,
  HolderAlgorithm,
  HolderSigner,
} from "./email-proof";
