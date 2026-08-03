import type { FetchFunction, IKVService, InvokeFunction, Result, ServiceError, ServiceHeaders, ServiceSession } from "@tinycloud/sdk-services";
import type { ShareAction, ShareCapabilityLike, ShareEnvelopeV2, ShareLinkLocation, ShareResource, ShareRecipientTarget } from "./share-envelope";
import type { PortableDelegation } from "./portable";

export type { ShareAction, ShareEnvelopeV2, ShareLinkLocation, ShareResource, ShareRecipientTarget };

/** Native action names used by the addressed Node data plane. */
export type ShareNativeAction = "tinycloud.kv/get" | "tinycloud.kv/metadata" | "tinycloud.kv/list" | "tinycloud.kv/put";
export type ShareWireAction = ShareNativeAction | "tinycloud.sql/read";
export type ShareAddressedRecipientMatcher = Exclude<ShareRecipientTarget, { readonly kind: "bearer" }>;

/** The closed v2 content-source union emitted by Node. */
export interface ShareKvContentSource {
  readonly kind: "kv";
  readonly action: ShareNativeAction;
  readonly space: string;
  readonly path: string;
}

export interface ShareSqlContentSource {
  readonly kind: "sql";
  readonly action: "tinycloud.sql/read";
  readonly space: string;
  readonly database: string;
  readonly path: string;
  readonly statement: string;
  readonly arguments: Readonly<Record<string, number>>;
  readonly argumentsDigest: string;
}

export type ShareContentSource = ShareKvContentSource | ShareSqlContentSource;

/** Inclusive expiry interval resolved by Node for an addressed policy. */
export interface ShareExpiryBounds {
  readonly expiryMin?: string;
  readonly expiryMax?: string;
}

/** Node's closed addressed-authoring v2 request. */
export interface ShareAddressedDelegationRequestV2 {
  readonly version: 2;
  readonly nonce: string;
  readonly jti: string;
  readonly senderDid: string;
  readonly recipientMatcher: ShareAddressedRecipientMatcher;
  readonly targetOrigin: string;
  readonly nodeAudience: string;
  readonly shareCid: string;
  readonly shareId: string;
  readonly delegationCid: string;
  readonly authorityMaterialHandle: string;
  readonly authorityMaterialDigest: string;
  readonly contentSource: ShareContentSource;
  readonly contentSourceDigest: string;
  readonly actions: readonly ShareWireAction[];
  readonly resource: { readonly kind: "exact" | "prefix"; readonly value: string };
  readonly expiresAt: string;
  readonly requestBodyDigest: string;
}

export interface ShareAddressedDelegationEnvelopeV2 {
  readonly request: ShareAddressedDelegationRequestV2;
  readonly proof: ShareDetachedProof;
}

export interface ShareAddressedDelegationResponseV2 {
  readonly type: "TinyCloudShareAddressedDelegation";
  readonly version: 2;
  readonly nonce: string;
  readonly jti: string;
  readonly policyCid: string;
  readonly policyBytes: string;
  readonly policyDigest: string;
  readonly delegationCid: string;
  readonly delegationBytes: string;
  readonly delegationDigest: string;
  readonly authorityMaterialHandle: string;
  readonly authorityMaterialDigest: string;
  readonly actions: readonly ShareWireAction[];
  readonly resource: { readonly kind: "exact" | "prefix"; readonly value: string };
  readonly expiresAt: string;
  readonly proof: ShareDetachedProof;
}

/** Closed v1 policy-session response emitted by Node's compatibility route. */
export interface SharePolicySessionWireV1 {
  readonly type: "TinyCloudSharePolicySession";
  readonly version: 1;
  readonly sessionId: string;
  readonly shareCid: string;
  readonly shareId: string;
  readonly delegationCid: string;
  readonly authorityMaterialHandle: string;
  readonly authorityMaterialDigest: string;
  readonly policyCid: string;
  readonly contentSource: ShareContentSource;
  readonly contentSourceDigest: string;
  readonly holderDid: string;
  readonly targetOrigin: string;
  readonly nodeAudience: string;
  readonly action: ShareWireAction;
  readonly actions?: readonly ShareWireAction[];
  readonly resource: string;
  readonly credentialDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Explicit v1 wire names retained for callers using the legacy read path. */
export type SharePolicySessionV1 = SharePolicySession;
export type ShareReadInvocationV1 = ShareNativeInvokeInput;

export interface ShareRecipientPolicy {
  readonly recipientMatcher: ShareRecipientTarget;
  readonly spaceId: string;
  readonly resource: ShareResource;
  readonly actions: readonly ShareAction[];
  readonly expiresAt: Date;
}

export interface ShareRecipientClientOptions {
  readonly trustedOrigins: readonly string[];
  readonly fetch?: FetchFunction;
  readonly invoke?: InvokeFunction;
  readonly createKVService?: (config: {
    hosts: string[];
    session: ServiceSession;
    invoke: InvokeFunction;
    fetch?: FetchFunction;
    pathPrefix?: string;
  }) => IKVService;
  /** Raw publication endpoint. The default is the Share raw artifact route. */
  readonly artifactUrl?: (input: { readonly origin: string; readonly cid: string }) => string;
  /** Trusted signer DIDs for addressed policy artifacts. */
  readonly trustedSignerDids?: readonly string[];
  /** A verified Node policy session. It is intentionally not a bearer token. */
  readonly establishPolicySession?: (input: {
    readonly envelope: ShareEnvelopeV2;
    readonly presentation?: unknown;
  }) => Promise<SharePolicySession>;
  /** Direct DID authorization is explicit and may return a resumable device step. */
  readonly establishRecipientDidSession?: (input: {
    readonly envelope: ShareEnvelopeV2;
    readonly recipientDid: string;
  }) => Promise<SharePolicySession | { readonly state: "authorization-required"; readonly method: "openkey-device"; readonly continueUrl?: string; readonly resumeToken: string } | { readonly state: "denied"; readonly reason: string }>;
  /**
   * Builds the holder presentation/session request after Node returns a
   * fresh challenge.  The callback is deliberately invoked only after the
   * challenge proof has been verified; callers cannot precompute a reusable
   * nonce-bound session request.
   */
  readonly buildPolicySessionRequest?: (input: {
    readonly envelope: ShareEnvelopeV2;
    readonly challenge: Readonly<Record<string, unknown>>;
    readonly challengeRequest: Readonly<Record<string, unknown>>;
  }) => Promise<unknown> | unknown;
  /**
   * Authoritative Node policy tuple. This is supplied by the Share host after
   * Node has created/persisted the policy; the recipient never invents it.
   */
  readonly policyBinding?: SharePolicyBinding;
  /** Holder proof signer used for the strict Node session and /invoke wires. */
  readonly holderSigner?: (input: {
    readonly domain: string;
    readonly message: Readonly<Record<string, unknown>>;
  }) => Promise<ShareDetachedProof> | ShareDetachedProof;
  /**
   * Node's addressed-sharing data plane. Implementations must sign the
   * application/vnd.tinycloud.share+json request with the holder proof and
   * send it to Node /invoke; the SDK never turns a policy session into a
   * generic KV bearer session.
   */
  readonly nativeInvoke?: (input: ShareNativeInvokeInput) => Promise<ShareNativeInvokeResult>;
  /** Import a normal policy-session UCAN through the caller's delegation manager. */
  readonly importDelegation?: (delegation: PortableDelegation) => Promise<void | PortableDelegation>;
  /** Extractable Ed25519 recipient seed used only to sign fresh S0 descendants/invocations. */
  readonly policySessionPrivateKey?: Uint8Array;
  /** Optional holder signer for the built-in addressed /invoke transport. */
  readonly signNativeInvoke?: (input: {
    readonly envelope: ShareEnvelopeV2;
    readonly session: SharePolicySession;
    readonly request: Readonly<Record<string, unknown>>;
  }) => Promise<ServiceHeaders> | ServiceHeaders;
  /** Optional route overrides for deployments that mount Share under a prefix. */
  readonly policyRoutes?: {
    readonly challenge?: string;
    readonly session?: string;
  };
  readonly presentation?: unknown;
  readonly bearerSession?: ServiceSession;
  readonly cache?: import("./ShareCache").ShareCache;
  readonly now?: () => Date;
  readonly maxInlineBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly maxContentBytes?: number;
  readonly maxSealedContentBytes?: number;
}

export interface SharePolicySession {
  readonly type?: "TinyCloudSharePolicySession";
  readonly version?: 1 | 2;
  readonly sessionId: string;
  readonly envelopeCid?: string;
  readonly registrationCid?: string;
  readonly shareCid?: string;
  readonly shareId?: string;
  readonly policyCid?: string;
  readonly enforcementDelegationCid?: string;
  readonly runtimeDelegation?: unknown;
  readonly holderDid: string;
  readonly expiresAt: string;
  readonly expiryMin?: string;
  readonly expiryMax?: string;
  readonly capability?: ShareCapabilityLike;
  readonly delegationCid?: string;
  readonly authorityMaterialHandle?: string;
  readonly authorityMaterialDigest?: string;
  readonly contentSource?: ShareContentSource;
  readonly contentSourceDigest?: string;
  readonly targetOrigin?: string;
  readonly nodeAudience?: string;
  readonly action?: ShareWireAction | ShareAction;
  readonly actions?: readonly (ShareWireAction | ShareAction)[];
  readonly resource?: ShareResource | string;
  readonly credentialDigest?: string;
  readonly credential?: string;
  readonly holderBinding?: unknown;
  readonly readSignerDid?: string;
  readonly holderSigner?: ShareRecipientClientOptions["holderSigner"];
  /** Legacy v1 transport fields retained for compatibility with Node sessions. */
  readonly authorization?: string;
  readonly delegationHeader?: { readonly Authorization?: string };
  readonly spaceId?: string;
  readonly origin?: string;
  readonly audience?: string;
  readonly sourceDigest?: string;
  readonly verificationMethod?: string;
  readonly jwk?: Readonly<Record<string, unknown>>;
}

export interface ShareDetachedProof {
  readonly alg: "EdDSA";
  readonly kid: string;
  readonly signature: string;
}

/** Exact fields Node resolves from its persisted policy authority tuple. */
export interface SharePolicyBinding {
  readonly envelopeCid?: string;
  readonly shareCid: string;
  readonly shareId: string;
  readonly registrationCid?: string;
  readonly delegationCid: string;
  readonly authorityMaterialHandle: string;
  readonly authorityMaterialDigest: string;
  readonly policyCid: string;
  readonly enforcementDelegationCid?: string;
  readonly enforcementDelegation?: unknown;
  readonly outerEnvelope?: unknown;
  readonly contentSource: ShareContentSource;
  readonly contentSourceDigest: string;
  readonly holderDid?: string;
  readonly targetOrigin: string;
  readonly nodeAudience: string;
  readonly action?: ShareWireAction | ShareAction;
  readonly actions?: readonly (ShareWireAction | ShareAction)[];
  readonly resource: ShareResource | string;
  readonly expiryMin?: string;
  readonly expiryMax?: string;
  readonly expiresAt?: string;
}

export interface ShareNativeInvokeInput {
  readonly envelope: ShareEnvelopeV2;
  readonly session: SharePolicySession;
  /** Native Node data-plane verb, kept distinct from public envelope actions. */
  readonly action: "get" | "metadata" | "list" | "put";
  readonly resource: string;
  readonly body?: Uint8Array;
  /** Digest of the exact decoded body; holder signing must cover this value. */
  readonly bodyDigest?: string;
  readonly contentType?: string;
  readonly ifMatch?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly mediaType: "application/vnd.tinycloud.share+json";
}

/** The legacy v1 /invoke wrapper remains named and closed for adapters. */
export interface ShareNativeInvokeEnvelopeV1 {
  readonly request: Readonly<Record<string, unknown>>;
  readonly limit?: number;
  readonly cursor?: string;
  readonly body?: string;
  readonly bodyDigest?: string;
  readonly ifMatch?: string;
  readonly contentType?: string;
}

export interface ShareNativeInvokeErrorResult {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

export interface ShareNativeInvokeSuccessResult {
  readonly status: number;
  readonly type: "TinyCloudShareInvokeResponse";
  readonly version: 2;
  readonly action: ShareNativeAction;
  readonly resource: string;
  readonly bytes?: Uint8Array;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly keys?: readonly string[];
  readonly truncated?: boolean;
  readonly nextCursor?: string;
  readonly entries?: readonly ShareListEntry[];
  /** Normalized header aliases accepted by native adapters. */
  readonly etag?: string;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly content?: string;
  readonly bodyDigest?: string;
}

export type ShareNativeInvokeResult = ShareNativeInvokeErrorResult | ShareNativeInvokeSuccessResult;

export interface ShareListEntry {
  readonly path: string;
  readonly kind: "file" | "folder";
}

export interface ShareReadResult {
  readonly bytes: Uint8Array;
  readonly etag?: string;
  readonly contentType?: string;
  readonly size: number;
}

export interface ShareMetadataResult {
  readonly metadata: Readonly<Record<string, string>>;
  readonly etag?: string;
  readonly contentType?: string;
  readonly size?: number;
}

export interface ShareListResult {
  readonly keys: readonly string[];
  readonly entries?: readonly ShareListEntry[];
  readonly nextCursor?: string;
  readonly truncated?: boolean;
}

export interface ShareSaveOptions {
  readonly etag: string;
  readonly contentType?: string;
}

export class ShareConflict extends Error {
  readonly code = "SHARE_CONFLICT" as const;
  readonly path: string;
  readonly etag?: string;

  constructor(path: string, etag?: string) {
    super(`The shared object at ${path} changed before it could be saved`);
    this.name = "ShareConflict";
    this.path = path;
    this.etag = etag;
  }
}

export class ShareAccessError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message?: string, details?: unknown) {
    super(message ?? "shared access could not be completed");
    this.name = "ShareAccessError";
    this.code = code;
    this.details = details;
  }
}

export interface ShareAccessV2 {
  readonly kind: "share-v2";
  readonly envelope: ShareEnvelopeV2;
  readonly location: ShareLinkLocation;
  readonly resource: ShareResource;
  readonly actions: readonly ShareAction[];
  readonly expiresAt: Date;
  /** The normal UCAN admitted for this recipient, when the link is v3. */
  readonly portableDelegation?: PortableDelegation;
  readonly kv?: IKVService;
  readonly get: (path?: string) => Promise<ShareReadResult>;
  readonly listChildren: (options?: { readonly path?: string; readonly limit?: number; readonly cursor?: string }) => Promise<ShareListResult>;
  readonly save: (path: string, bytes: Uint8Array, options: ShareSaveOptions) => Promise<{ readonly etag?: string }>;
  readonly metadata: (path?: string) => Promise<ShareMetadataResult>;
}

export type ShareRecipientResult<T> = Result<T, ServiceError | ShareAccessError | ShareConflict>;
