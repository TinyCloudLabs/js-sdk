// Subpath entry for headless clients (e.g. the CLI). Re-exports the credential driver and the offline
// stored-credential verifier from @tinycloud/node-sdk/credentials. Built as its own entry by webpack.config.cjs.
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
// Held credentials: the account-holder signer, the owner-scoped held store, and the held credential source.
export { createAccountHolderSigner } from "./credentials/account-holder";
export {
  findHeldCredential,
  listHeldEmailCredentials,
  storeHeldCredential,
} from "./credentials/held-store";
export type {
  FindHeldCredentialInput,
  HeldCredentialRecord,
  HeldIssuerPolicy,
  HeldMatch,
  HeldStorageReceipt,
  ListHeldEmailCredentialsInput,
  StoreHeldCredentialInput,
} from "./credentials/held-store";
export { acquireHeldCredential } from "./credentials/held-source";
export type { HeldAcquireInput, HeldCredentialResult } from "./credentials/held-source";
