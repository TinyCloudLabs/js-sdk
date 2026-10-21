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
  EMAIL_PROOF_CREDENTIAL_TYPE,
  EMAIL_PROOF_PENDING_MAX_MS,
  EMAIL_PROOF_PROFILE,
  EMAIL_PROOF_WITNESS_ORIGIN,
  EmailProofError,
  completeEmailProof,
  requestEmailProofCode,
} from "./credentials/email-proof";
export type {
  EmailProofErrorCode,
  EmailProofHolder,
  EmailProofOptions,
  EmailProofPending,
  EmailProofResult,
  EmailProofStep,
} from "./credentials/email-proof";
