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
