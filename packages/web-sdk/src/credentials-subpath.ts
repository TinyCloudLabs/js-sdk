// Subpath entry for headless clients (e.g. the CLI). Re-exports the credential driver, the offline
// stored-credential verifier and the share-presentation builder from @tinycloud/node-sdk/credentials. Built as its own entry by webpack.config.cjs.
export { OpenCredentialsHttpTransport } from "@tinycloud/node-sdk/credentials";
export { interpretCredentialFlow } from "@tinycloud/node-sdk/credentials";
export type {
  CredentialAcquisitionTransport,
  CredentialRequestState,
  CredentialSigningAdapter,
  PrimitiveStepHandler,
  PrimitiveStepResult,
} from "@tinycloud/node-sdk/credentials";
export {
  acquireEmailProof,
  completeEmailProof,
  createEd25519HolderSigner,
  createMemoryEmailProofPendingStore,
  EmailProofError,
  requestEmailProofCode,
  verifyStoredEmailProof,
} from "@tinycloud/node-sdk/credentials";
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
  StoredEmailProofInput,
  StoredEmailProofRecord,
} from "@tinycloud/node-sdk/credentials";
export { buildSharePresentation, SharePresentationError } from "@tinycloud/node-sdk/credentials";
export type {
  BuildSharePresentationInput,
  SharePresentationChallenge,
  SharePresentationErrorCode,
  SharePresentationMaterial,
} from "@tinycloud/node-sdk/credentials";
