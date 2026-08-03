import type {
  ClientSession,
  CredentialFlowDescriptor,
  CredentialHolderBinding,
  CredentialIssuerMetadata,
  CredentialProgressEvent,
  CredentialRequirement,
  CredentialStorageReceipt,
  IssuedCredentialEnvelope,
  IKVService,
  StoredCredentialRecord,
  VerifiedCredential,
  PolicyCredentialAdmissionV3,
  UnifiedPolicyCapability,
  UnifiedPolicyV2,
} from "@tinycloud/sdk-core";
import type { ValidatedRuntimeDelegation } from "@tinycloud/node-sdk/core";

export interface CredentialClient {
  readonly sessionDid: string;
  readonly credentialHolderDid: string;
  readonly credentialHolderKid: string;
  session(): ClientSession | undefined;
  signSessionBytes(bytes: Uint8Array): Promise<Uint8Array>;
  autoSignCredentialBytes?(bytes: Uint8Array): Promise<Uint8Array | undefined>;
  approveCredentialBytes?(bytes: Uint8Array): Promise<Uint8Array>;
  activateCompactRuntimeDelegation?(input: {
    readonly authorization: string;
    readonly cid: string;
    readonly host: string;
  }): Promise<ValidatedRuntimeDelegation>;
  ensureOwnedSpaceHosted(name: string): Promise<string>;
  credentialSpaceOwnerDid(spaceId: string): string;
  kvForSpace(spaceId: string): IKVService;
  /**
   * Root authorization CID of the active account session. Exposed here rather
   * than on {@link ClientSession} so the CID stays out of the public session.
   */
  accountAuthorizationCid(): string;
}

export interface CredentialSigningAdapter {
  /** Return undefined when the existing exact-request auto-sign policy does not apply. */
  readonly autoSign?: (binding: CredentialHolderBinding, bytes: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array | undefined>;
  /** Invoke the normal OpenKey approval surface. */
  readonly requestApproval?: (binding: CredentialHolderBinding, bytes: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array>;
}

export type PrimitiveStepResult = Readonly<Record<string, string | boolean>>;
export type PrimitiveStepHandler = (input: {
  readonly descriptor: CredentialFlowDescriptor;
  readonly requirement: CredentialRequirement;
  readonly stepId: string;
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}) => Promise<PrimitiveStepResult>;

export interface CredentialInteractionAdapter {
  readonly kind: "popup" | "redirect" | "headless";
  start(input: { readonly interaction: CredentialFlowDescriptor["interaction"]; readonly locator: string; readonly signal?: AbortSignal }): Promise<{ readonly wake: () => Promise<void>; readonly close: () => void; readonly closed: () => boolean }>;
}

export interface CredentialRedirectResumeState {
  readonly type: "TinyCloudCredentialRedirectResume";
  readonly version: 1;
  readonly requestId: string;
  readonly locator: string;
  readonly verifier: string;
  readonly expiresAt: string;
  readonly correlationId: string;
  readonly holderDid: string;
  readonly descriptorDigest: string;
  readonly requirementDigest: string;
  readonly openerOrigin: string;
}

export interface CredentialRedirectStore {
  load(): Promise<CredentialRedirectResumeState | undefined>;
  save(state: CredentialRedirectResumeState): Promise<void>;
  clear(): Promise<void>;
}

export interface CredentialRequestState {
  readonly type: "OpenCredentialsAcquisitionState";
  readonly version: 1;
  readonly requestId: string;
  readonly transitionId: string;
  readonly state: "pending" | "ready_to_issue" | "issued" | "complete" | "expired" | "canceled" | "issuer_unready";
  readonly nextStep?: { readonly id: string; readonly type: "collect_input" | "mailbox_otp" | "holder_signature"; readonly version: 1; readonly constraints: Readonly<Record<string, unknown>> };
  readonly retryAfterMs?: number;
  readonly correlationId: string;
}

export interface CredentialAcquisitionTransport {
  create(input: { readonly descriptor: CredentialFlowDescriptor; readonly descriptorDigest: string; readonly requirement: CredentialRequirement; readonly requirementDigest: string; readonly holderDid: string; readonly openerOrigin: string; readonly completionVerifierChallenge: string; readonly signal?: AbortSignal }): Promise<{ readonly requestId: string; readonly locator: string; readonly expiresAt: string; readonly correlationId: string }>;
  state(requestId: string, verifier: string, signal?: AbortSignal): Promise<CredentialRequestState>;
  beginStep(requestId: string, verifier: string, stepId: "collect_input" | "mailbox_otp", signal?: AbortSignal): Promise<void>;
  submitStep(requestId: string, verifier: string, stepId: string, proof: PrimitiveStepResult, signal?: AbortSignal): Promise<void>;
  holderBinding(requestId: string, verifier: string, signal?: AbortSignal): Promise<CredentialHolderBinding>;
  submitHolderSignature(requestId: string, verifier: string, signature: string, signal?: AbortSignal): Promise<void>;
  issue(requestId: string, verifier: string, signal?: AbortSignal): Promise<void>;
  result(requestId: string, verifier: string, signal?: AbortSignal): Promise<IssuedCredentialEnvelope>;
  issuerMetadata(signal?: AbortSignal): Promise<CredentialIssuerMetadata>;
  checkStatus(status: IssuedCredentialEnvelope["status"], signal?: AbortSignal): Promise<boolean>;
}

export interface CredentialsOperationOptions {
  readonly descriptor?: CredentialFlowDescriptor;
  readonly discoveryUrl?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (event: CredentialProgressEvent) => void;
  readonly now?: () => Date;
}

export interface CredentialsAcquireOptions extends CredentialsOperationOptions {
  readonly interaction?: "popup" | "redirect" | "headless";
  readonly browser?: CredentialInteractionAdapter;
  readonly transport?: CredentialAcquisitionTransport;
  readonly signing?: CredentialSigningAdapter;
  readonly stepHandlers?: Partial<Record<"collect_input" | "mailbox_otp", PrimitiveStepHandler>>;
  readonly openerOrigin?: string;
  /** Same-origin, request-scoped persistence used to resume a full-page redirect. */
  readonly redirectStore?: CredentialRedirectStore;
}

export interface CredentialsEnsureOptions extends CredentialsAcquireOptions {}

export interface CredentialsEnsureResult {
  readonly status: "reused" | "acquired";
  readonly credential: VerifiedCredential;
  readonly record: StoredCredentialRecord;
  readonly receipt?: CredentialStorageReceipt;
}

export interface CredentialsPolicyAdmissionOptions {
  readonly ensured: CredentialsEnsureResult;
  readonly policy: UnifiedPolicyV2;
  readonly policyCid: string;
  readonly policyRootCid: string;
  readonly enforcementRootCid: string;
  readonly requirement: CredentialRequirement;
  readonly requestedCapabilities: readonly UnifiedPolicyCapability[];
  readonly nodeOrigin: string;
  readonly fetch?: typeof fetch;
  readonly now?: Date;
  readonly jti?: string;
}

export interface CredentialsPolicyAdmissionResult
  extends PolicyCredentialAdmissionV3 {
  readonly installed: ValidatedRuntimeDelegation;
}
