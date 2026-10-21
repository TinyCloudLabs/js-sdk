// Subpath entry for headless clients (e.g. the CLI). Keeps the credential
// transport out of the root `index` bundle so the root graph is unchanged.
export { OpenCredentialsHttpTransport } from "./credentials/transport";
export type {
  CredentialAcquisitionTransport,
  CredentialRequestState,
  PrimitiveStepResult,
} from "./credentials/types";
