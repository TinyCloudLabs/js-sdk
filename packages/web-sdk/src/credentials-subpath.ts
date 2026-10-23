// Subpath entry for headless clients (e.g. the CLI). Re-exports the single
// credential driver from @tinycloud/node-sdk/credentials; the export list is unchanged.
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
} from "@tinycloud/node-sdk/credentials";
