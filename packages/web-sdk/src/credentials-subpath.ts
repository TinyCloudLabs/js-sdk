// Subpath entry for headless clients (e.g. the CLI). Keeps the credential
// transport and interpreter out of the root `index` bundle so the root graph is unchanged.
export { OpenCredentialsHttpTransport } from "./credentials/transport";
export { interpretCredentialFlow } from "./credentials/interpreter";
export type {
  CredentialAcquisitionTransport,
  CredentialRequestState,
  CredentialSigningAdapter,
  PrimitiveStepHandler,
  PrimitiveStepResult,
} from "./credentials/types";
export {
  acquireEmailProof,
  completeEmailProof,
  createEd25519HolderSigner,
  createMemoryEmailProofPendingStore,
  EmailProofError,
  requestEmailProofCode,
} from "./credentials/email-proof";
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
} from "./credentials/email-proof";
