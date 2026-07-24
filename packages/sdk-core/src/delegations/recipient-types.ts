import type { FetchFunction, IKVService, InvokeFunction, Result, ServiceError, ServiceHeaders, ServiceSession } from "@tinycloud/sdk-services";
import type { ShareAction, ShareCapabilityLike, ShareEnvelopeV2, ShareLinkLocation, ShareResource, ShareRecipientTarget } from "./share-envelope";

export type { ShareAction, ShareEnvelopeV2, ShareLinkLocation, ShareResource, ShareRecipientTarget };

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
}

export interface SharePolicySession {
  readonly sessionId: string;
  readonly shareCid?: string;
  readonly shareId?: string;
  readonly policyCid?: string;
  readonly holderDid: string;
  readonly expiresAt: string;
  readonly capability?: ShareCapabilityLike;
  readonly delegationCid?: string;
  readonly authorityMaterialHandle?: string;
  readonly authorityMaterialDigest?: string;
  readonly contentSource?: Record<string, unknown>;
  readonly contentSourceDigest?: string;
  readonly targetOrigin?: string;
  readonly nodeAudience?: string;
  readonly action?: string;
  readonly actions?: readonly string[];
  readonly resource?: string;
  readonly credentialDigest?: string;
  readonly credential?: string;
  readonly holderBinding?: unknown;
  readonly readSignerDid?: string;
  readonly holderSigner?: ShareRecipientClientOptions["holderSigner"];
  readonly [key: string]: unknown;
}

export interface ShareDetachedProof {
  readonly alg: "EdDSA";
  readonly kid: string;
  readonly signature: string;
}

/** Exact fields Node resolves from its persisted policy authority tuple. */
export interface SharePolicyBinding {
  readonly shareCid: string;
  readonly shareId: string;
  readonly delegationCid: string;
  readonly authorityMaterialHandle: string;
  readonly authorityMaterialDigest: string;
  readonly policyCid: string;
  readonly contentSource: Record<string, unknown>;
  readonly contentSourceDigest: string;
  readonly holderDid?: string;
  readonly targetOrigin: string;
  readonly nodeAudience: string;
  readonly action?: string;
  readonly actions?: readonly string[];
  readonly resource: string;
  readonly expiresAt?: string;
}

export interface ShareNativeInvokeInput {
  readonly envelope: ShareEnvelopeV2;
  readonly session: SharePolicySession;
  /** Native Node data-plane verb, kept distinct from public envelope actions. */
  readonly action: "get" | "list" | "put";
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

export interface ShareNativeInvokeResult {
  readonly status: number;
  readonly bytes?: Uint8Array;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly keys?: readonly string[];
  readonly truncated?: boolean;
  readonly nextCursor?: string;
  readonly entries?: readonly ShareListEntry[];
}

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

  constructor(code: string, message?: string) {
    super(message ?? "shared access could not be completed");
    this.name = "ShareAccessError";
    this.code = code;
  }
}

export interface ShareAccessV2 {
  readonly kind: "share-v2";
  readonly envelope: ShareEnvelopeV2;
  readonly location: ShareLinkLocation;
  readonly resource: ShareResource;
  readonly actions: readonly ShareAction[];
  readonly expiresAt: Date;
  readonly kv?: IKVService;
  readonly get: (path?: string) => Promise<ShareReadResult>;
  readonly listChildren: (options?: { readonly path?: string; readonly limit?: number; readonly cursor?: string }) => Promise<ShareListResult>;
  readonly save: (path: string, bytes: Uint8Array, options: ShareSaveOptions) => Promise<{ readonly etag?: string }>;
}

export type ShareRecipientResult<T> = Result<T, ServiceError | ShareAccessError | ShareConflict>;
