// The credential driver lives in @tinycloud/node-sdk/credentials-core (single copy).
// Only the DOM-bound options live here; the headless core carries no DOM types.
import type {
  CredentialsAcquireOptions as CoreCredentialsAcquireOptions,
} from "@tinycloud/node-sdk/credentials-core";

/** Browser acquisition options. `mountTarget` is the SDK-owned UI's DOM anchor. */
export interface CredentialsAcquireOptions extends CoreCredentialsAcquireOptions {
  /** An element or selector inside the current document for the SDK-owned UI. */
  readonly mountTarget?: Element | string;
}

export interface CredentialsEnsureOptions extends CredentialsAcquireOptions {}

export type {
  CredentialAcquisitionTheme,
  CredentialAcquisitionTransport,
  CredentialBrowserInteractionAdapter,
  CredentialClient,
  CredentialInlineInteractionAdapter,
  CredentialInputRequest,
  CredentialInteractionAdapter,
  CredentialInteractionKind,
  CredentialInteractionSurface,
  CredentialProofSubject,
  CredentialRedirectResumeState,
  CredentialRedirectStore,
  CredentialRequestState,
  CredentialSigningAdapter,
  CredentialsEnsureResult,
  CredentialsOperationOptions,
  CredentialsPolicyAdmissionOptions,
  CredentialsPolicyAdmissionResult,
  InlineCredentialProofHandler,
  InlineCredentialProofRequest,
  PrimitiveStepHandler,
  PrimitiveStepResult,
  ReceiverCredentialCustody,
} from "@tinycloud/node-sdk/credentials-core";
