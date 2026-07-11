import { bytesToHex, sha256 } from "viem";
import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import type { InvokeFunction, ServiceHeaders, ServiceSession } from "@tinycloud/sdk-services";
import { z } from "zod";
import {
  POLICY_VERSION_V0,
  TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA,
  OWNER_NODE_ENDPOINT_SCHEMA,
  W3C_VC_CREDENTIAL_VERIFIER,
  jcsCanonicalize,
  normalizePolicyCapability,
  normalizeJson,
  policyCapabilityContains,
  verifyPolicyEngineRecordForRequester,
  type PolicyCapability,
  type TranscriptShareBootstrap,
} from "../policy";

export const REQUESTER_NEAR_EXPIRY_SECONDS = 30;
export const REQUESTER_ENGINE_RETRY_ATTEMPTS = 3;
export const REQUESTER_ENGINE_RETRY_MAX_DELAY_MS = 250;

export const POLICY_ENGINE_CHALLENGE_REQUEST_SCHEMA =
  "xyz.tinycloud.policy-engine/challenge-request/v0" as const;
export const POLICY_ENGINE_CHALLENGE_RESPONSE_SCHEMA =
  "xyz.tinycloud.policy/challenge/v0" as const;
export const POLICY_ENGINE_RESOLVE_REQUEST_SCHEMA =
  "xyz.tinycloud.policy/presentation/v0" as const;
export const POLICY_ENGINE_DENIAL_SCHEMA =
  "xyz.tinycloud.policy-engine/denial/v0" as const;
export const HOLDER_KEY_BINDING_PRESENTATION_SCHEMA =
  "xyz.tinycloud.policy/presentation/v0" as const;
export const PORTABLE_DELEGATION_SCHEMA =
  "xyz.tinycloud.policy/portable-delegation/v0" as const;

export const POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES = [
  "schema-invalid",
  "challenge-not-found",
  "challenge-expired",
  "challenge-nonce-consumed",
  "presentation-expired",
  "presentation-audience-mismatch",
  "presentation-evidence-missing",
  "digest-mismatch",
  "evidence-requirement-unknown",
  "evidence-requirement-duplicate",
  "holder-signature-invalid",
  "holder-signature-signer-mismatch",
  "id-mismatch",
  "requested-capabilities-exceeded",
  "requested-capabilities-hash-mismatch",
  "evidence-authority-missing",
  "evidence-credential-invalid",
  "evidence-domain-invalid",
  "evidence-domain-missing",
  "evidence-freshness-expired",
  "evidence-freshness-unestablishable",
  "evidence-issuer-missing",
  "evidence-issuer-untrusted",
  "evidence-presentation-invalid",
  "evidence-requirements-invalid",
  "evidence-verifier-unsupported",
  "enrollment-binding-mismatch",
  "enrollment-expired",
  "enrollment-not-yet-valid",
  "enrollment-out-of-scope",
  "enrollment-revoked",
  "enrollment-revoked-irreversible",
  "enrollment-status-rollback",
  "signature-invalid",
  "signer-not-authorized",
  "audience-mismatch",
  "capability-not-contained",
  "evidence-invalid",
  "evidence-missing",
  "evidence-stale",
  "evidence-subject-mismatch",
  "evidence-untrusted",
  "grant-ttl-exceeds-policy",
  "holder-did-mismatch",
  "holder-key-not-permitted",
  "holder-signature-invalid",
  "owner-mismatch",
  "policy-expired",
  "policy-inactive",
  "policy-not-found",
  "policy-not-satisfied",
  "policy-revoked",
  "policy-status-rollback",
  "rate-limited",
] as const;

export type PolicyEngineGrantPresentationDenialCode =
  (typeof POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES)[number];

export type TranscriptRequesterErrorCode =
  | "requester-bootstrap-malformed"
  | "requester-bootstrap-unknown-key"
  | "requester-engine-record-signature-invalid"
  | "requester-engine-record-owner-mismatch"
  | "requester-engine-record-audience-mismatch"
  | "requester-engine-record-endpoint-mismatch"
  | "requester-engine-record-invalid"
  | "requester-engine-unreachable"
  | "requester-engine-response-invalid"
  | "requester-renewal-required"
  | "requester-challenge-reused"
  | "requester-presentation-invalid"
  | "requester-delegation-invalid"
  | "requester-delegation-wrong-holder"
  | "requester-delegation-not-refresh-only"
  | "requester-delegation-ttl-excessive"
  | "requester-delegation-capability-wider"
  | "requester-owner-node-endpoint-invalid"
  | "requester-delegation-import-failed"
  | "requester-invocation-signer-required"
  | "requester-invocation-signer-mismatch"
  | "requester-node-denied"
  | "requester-node-unreachable"
  | "requester-node-response-invalid"
  | "requester-access-not-contained"
  | "requester-access-denied"
  | "requester-access-unreachable"
  | "requester-access-ended"
  | `policy-engine-denied-${PolicyEngineGrantPresentationDenialCode}`;

export type TranscriptRequesterErrorState =
  | "bootstrap-invalid"
  | "denied"
  | "unreachable"
  | "renewal-required"
  | "access-ended"
  | "invalid"
  | "not-contained";

export class TranscriptRequesterError extends Error {
  public readonly code: TranscriptRequesterErrorCode;
  public readonly state: TranscriptRequesterErrorState;
  public readonly denialCode?: PolicyEngineGrantPresentationDenialCode;
  public readonly status?: number;

  constructor(
    code: TranscriptRequesterErrorCode,
    message: string,
    state: TranscriptRequesterErrorState = "invalid",
    denialCode?: PolicyEngineGrantPresentationDenialCode,
    status?: number,
  ) {
    super(message);
    this.name = "TranscriptRequesterError";
    this.code = code;
    this.state = state;
    this.denialCode = denialCode;
    this.status = status;
  }
}

export interface RequesterHttpRequest {
  readonly method: "POST" | "GET";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface RequesterHttpResponse {
  readonly status: number;
  readonly body: unknown;
  /** Required for owner-node requests; the transport reports the non-redirected final URL. */
  readonly finalUrl?: string;
  /** Required for owner-node requests; the transport reports the actual connected IP. */
  readonly resolvedAddress?: string;
}

export interface RequesterEndpointResolution {
  readonly addresses: readonly string[];
}

export interface RequesterTransport {
  request(request: RequesterHttpRequest): Promise<RequesterHttpResponse>;
  /** Resolve before egress so the requester can pin public addresses and detect rebinding. */
  resolveEndpoint?(endpoint: string): Promise<RequesterEndpointResolution>;
}

export interface RequesterInvocationCapability {
  readonly holderDid: string;
  readonly verificationMethod: string;
  readonly jwk: object;
  readonly invoke: InvokeFunction;
}

export interface HolderKeyBindingPresentation {
  readonly schema: typeof HOLDER_KEY_BINDING_PRESENTATION_SCHEMA;
  readonly policyId: string;
  readonly eligibleSubjectDid: string;
  readonly holderDid: string;
  readonly holderBinding: unknown;
  readonly requestedCapabilities: readonly PolicyCapability[];
  readonly requestedCapabilitiesHash: string;
  readonly audience: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly evidence?: readonly unknown[];
  readonly holderSignature: {
    readonly suite: string;
    readonly signerDid: string;
    readonly value: string;
  };
}

export interface RequesterSigningCapability {
  readonly holderDid: string;
  readonly keyId: string;
  readonly suite?: string;
  readonly holderBinding?: unknown;
  readonly eligibleSubjectDid?: string;
  readonly evidence?: readonly unknown[];
  signGrantPresentation?(input: {
    readonly schema: typeof HOLDER_KEY_BINDING_PRESENTATION_SCHEMA;
    readonly policyId: string;
    readonly eligibleSubjectDid: string;
    readonly holderDid: string;
    readonly holderBinding: unknown;
    readonly requestedCapabilities: readonly PolicyCapability[];
    readonly requestedCapabilitiesHash: string;
    readonly audience: string;
    readonly nonce: string;
    readonly expiresAt: string;
    readonly evidence?: readonly unknown[];
  }): Promise<string> | string;
  signKeyBinding(input: {
    readonly schema: typeof HOLDER_KEY_BINDING_PRESENTATION_SCHEMA;
    readonly policyId?: string;
    readonly eligibleSubjectDid?: string;
    readonly holderDid: string;
    readonly holderBinding?: unknown;
    readonly requestedCapabilities?: readonly PolicyCapability[];
    readonly requestedCapabilitiesHash?: string;
    readonly audience: string;
    readonly nonce: string;
    readonly challengeId: string;
    readonly issuedAt: string;
    readonly keyId: string;
  }): Promise<string> | string;
}

export interface PortableDelegation {
  readonly schema?: typeof PORTABLE_DELEGATION_SCHEMA;
  readonly delegationId: string;
  readonly policyId: string;
  readonly issuerDid: string;
  readonly holderDid: string;
  readonly audience?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly terminal: boolean;
  readonly maxTtlSeconds: number;
  readonly capabilities: readonly PolicyCapability[];
  readonly encoded?: string;
}

export interface TranscriptRequesterOptions {
  readonly bootstrap: unknown;
  readonly requesterDid: string;
  readonly ownerDid: string;
  readonly audience: string;
  readonly grantIssuerDid: string;
  readonly transport: RequesterTransport;
  readonly signingCapability?: RequesterSigningCapability;
  readonly invocationCapability?: RequesterInvocationCapability;
  readonly eligibleSubjectDid?: string;
  readonly holderBinding?: unknown;
  readonly evidence?: readonly unknown[];
  readonly presentationTtlSeconds?: number;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly engineRetryAttempts?: number;
}

export interface TranscriptRequesterReadSqlResult {
  readonly rows: readonly unknown[];
}

export interface TranscriptRequesterReadKvResult {
  readonly value: unknown;
}

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const Rfc3339Schema = z
  .string()
  .refine((value) => parseStrictRfc3339(value) !== undefined, {
    message: "must be strict RFC 3339 date-time with timezone",
  });

const SignedRecordSchema = z
  .object({
    schema: z.string(),
    engineRecordId: z.string(),
    ownerDid: z.string(),
    endpoint: z.string(),
    audience: z.string(),
    supportedPolicyVersions: z.array(z.string()),
    supportedEvidenceVerifiers: z.array(z.string()),
    grantIssuerDid: z.string(),
    expiresAt: Rfc3339Schema,
    signature: z
      .object({
        suite: z.string(),
        signerDid: z.string(),
        value: z.string(),
      })
      .strict(),
  })
  .strict();

const PolicyEngineSchema = z
  .object({
    endpoint: z.string().url(),
    audience: z.string(),
    supportedEvidenceVerifiers: z.tuple([z.literal(W3C_VC_CREDENTIAL_VERIFIER)]),
    signedRecord: SignedRecordSchema,
  })
  .strict();

const OwnerNodeSchema = z
  .object({
    schema: z.literal(OWNER_NODE_ENDPOINT_SCHEMA),
    endpoint: z.string().url(),
    spaceId: z.string().min(1),
  })
  .strict();

const ResourceHintSchema = z
  .object({
    resourceType: z.string(),
    resourceId: z.string(),
    requestedCapabilities: z.array(JsonValueSchema).min(1),
  })
  .strict();

const BootstrapSchema = z
  .object({
    schema: z.literal(TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA),
    policyId: z.string(),
    policyEngine: PolicyEngineSchema,
    ownerNode: OwnerNodeSchema,
    resourceHint: ResourceHintSchema,
  })
  .strict();

const SignatureSchema = z
  .object({
    suite: z.string(),
    signerDid: z.string(),
    value: z.string(),
  })
  .strict();

const ChallengeSchema = z
  .object({
    schema: z.literal(POLICY_ENGINE_CHALLENGE_RESPONSE_SCHEMA),
    challengeId: z.string(),
    policyId: z.string(),
    audience: z.string(),
    nonce: z.string().min(16),
    challengeExpiresAt: Rfc3339Schema,
    acceptedSuites: z.array(z.string()).min(1),
    requestedCapabilitiesTemplate: z.array(JsonValueSchema).optional(),
    signature: SignatureSchema,
  })
  .strict();

const ChallengeResponseSchema = z.object({ challenge: ChallengeSchema }).strict();

const DenialSchema = z
  .object({
    schema: z.literal(POLICY_ENGINE_DENIAL_SCHEMA),
    code: z.enum(POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES),
    message: z.string().optional(),
  })
  .strict();

const ErrorEnvelopeDenialSchema = z
  .object({
    error: z
      .object({
        code: z.enum(POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES),
        message: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const CapabilitySchema = z
  .object({
    service: z.enum(["tinycloud.kv", "tinycloud.sql", "tinycloud.vfs"]),
    space: z.string(),
    path: z.string(),
    actions: z.array(z.string()).min(1),
    caveats: JsonValueSchema.optional(),
  })
  .strict();

const WireDelegationSchema = z
  .object({
    delegationId: z.string(),
    issuerDid: z.string(),
    holderDid: z.string(),
    policyId: z.string(),
    capabilities: z.array(CapabilitySchema).min(1).optional(),
    issuanceId: z.string().optional(),
    capabilityHashHex: z.string().optional(),
    revocationMode: z.literal("refresh_only").optional(),
    issuedAt: Rfc3339Schema,
    expiresAt: Rfc3339Schema,
    terminal: z.boolean(),
    encoded: z.string(),
  })
  .strict();

const ResolveResponseSchema = z.object({ delegation: WireDelegationSchema }).strict();
const DelegateReceiptSchema = z
  .object({ cid: z.string().min(1), activated: z.array(z.string()), skipped: z.array(z.string()) })
  .strict();

const SqlReadResponseSchema = z.object({ rows: z.array(JsonValueSchema) }).strict();
const KvReadResponseSchema = z.object({ value: JsonValueSchema }).strict();

export const LISTEN_SQL_STATEMENT_CATALOG = [
  {
    name: "listen.getConversation",
    sql: "SELECT id, title, source, source_id, source_url, started_at, ended_at, duration_secs, summary, metadata, transcript_json, transcript_text, created_at, updated_at FROM conversation WHERE id = ?",
    fixedParams: [{ index: 0, value: "{conversationId}" }],
  },
  {
    name: "listen.listParticipants",
    sql: "SELECT id, name, email, speaker_label FROM participant WHERE conversation_id = ? ORDER BY COALESCE(speaker_label, name), id",
    fixedParams: [{ index: 0, value: "{conversationId}" }],
  },
] as const;

export type ListenSqlStatementName = (typeof LISTEN_SQL_STATEMENT_CATALOG)[number]["name"];
type ListenSqlStatement = (typeof LISTEN_SQL_STATEMENT_CATALOG)[number];
type NormalizedWireDelegation = Omit<PortableDelegation, "capabilities"> & {
  readonly capabilities: readonly z.infer<typeof CapabilitySchema>[];
};

const LISTEN_SQL_STATEMENT_BY_NAME: ReadonlyMap<string, ListenSqlStatement> = new Map(
  LISTEN_SQL_STATEMENT_CATALOG.map((statement) => [statement.name, statement]),
);

export class TranscriptRequester {
  private readonly bootstrap: TranscriptShareBootstrap;
  private readonly requesterDid: string;
  private readonly ownerDid: string;
  private readonly audience: string;
  private readonly grantIssuerDid: string;
  private readonly transport: RequesterTransport;
  private readonly signingCapability?: RequesterSigningCapability;
  private readonly invocationCapability?: RequesterInvocationCapability;
  private readonly ownerNodeAddresses: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly engineRetryAttempts: number;
  private readonly requestedCapabilities: readonly PolicyCapability[];
  private readonly requestedCapabilitiesHash: string;
  private readonly eligibleSubjectDid: string;
  private readonly holderBinding: unknown;
  private readonly evidence?: readonly unknown[];
  private readonly presentationTtlSeconds: number;
  private readonly usedChallengeNonces = new Set<string>();
  private importedDelegation?: PortableDelegation;
  private importedDelegationCid?: string;
  private accessEnded = false;

  private constructor(
    bootstrap: TranscriptShareBootstrap,
    requestedCapabilities: readonly PolicyCapability[],
    requestedCapabilitiesHash: string,
    ownerNodeAddresses: ReadonlySet<string>,
    options: TranscriptRequesterOptions,
  ) {
    this.bootstrap = bootstrap;
    this.requestedCapabilities = requestedCapabilities;
    this.requestedCapabilitiesHash = requestedCapabilitiesHash;
    this.requesterDid = options.requesterDid;
    this.ownerDid = options.ownerDid;
    this.audience = options.audience;
    this.grantIssuerDid = options.grantIssuerDid;
    this.transport = options.transport;
    this.signingCapability = options.signingCapability;
    this.invocationCapability = options.invocationCapability;
    this.ownerNodeAddresses = ownerNodeAddresses;
    this.eligibleSubjectDid =
      options.eligibleSubjectDid ?? options.signingCapability?.eligibleSubjectDid ?? options.requesterDid;
    this.holderBinding =
      options.holderBinding ??
      options.signingCapability?.holderBinding ?? {
        type: "enrolled-agent",
        enrollment: {
          schema: "xyz.tinycloud.policy/holder-enrollment/v0",
          holderDid: options.requesterDid,
        },
      };
    this.evidence = options.evidence ?? options.signingCapability?.evidence;
    this.presentationTtlSeconds = Math.min(Math.max(options.presentationTtlSeconds ?? 60, 1), 300);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.engineRetryAttempts = options.engineRetryAttempts ?? REQUESTER_ENGINE_RETRY_ATTEMPTS;
  }

  static async create(options: TranscriptRequesterOptions): Promise<TranscriptRequester> {
    const bootstrap = parseBootstrap(options.bootstrap);
    const ownerNodeAddresses = await validateAndResolveOwnerNode(bootstrap.ownerNode.endpoint, options.transport);
    const record = await verifyRecordBeforeEgress(bootstrap, options);
    if (record.endpoint !== bootstrap.policyEngine.endpoint) {
      throw new TranscriptRequesterError(
        "requester-engine-record-endpoint-mismatch",
        "policy engine record endpoint does not match bootstrap endpoint",
        "bootstrap-invalid",
      );
    }
    if (record.audience !== bootstrap.policyEngine.audience) {
      throw new TranscriptRequesterError(
        "requester-engine-record-audience-mismatch",
        "policy engine record audience does not match bootstrap audience",
        "bootstrap-invalid",
      );
    }
    const requestedCapabilities = bootstrap.resourceHint.requestedCapabilities.map((capability, index) =>
      parsePolicyCapability(capability, `$.resourceHint.requestedCapabilities[${index}]`),
    );
    return new TranscriptRequester(
      bootstrap,
      requestedCapabilities,
      requestedCapabilitiesHash(requestedCapabilities),
      ownerNodeAddresses,
      options,
    );
  }

  get accessState(): "active" | "needs-renewal" | "access-ended" {
    if (this.accessEnded) {
      return "access-ended";
    }
    if (this.importedDelegation === undefined) {
      return "needs-renewal";
    }
    if (this.requiresRenewal(this.importedDelegation)) {
      return "needs-renewal";
    }
    return "active";
  }

  async readSql(statementName: ListenSqlStatementName): Promise<TranscriptRequesterReadSqlResult> {
    try {
      const statement = listenSqlStatementFromCatalog(statementName);
      const delegation = await this.ensureFreshDelegation();
      const requested = this.sqlAccessCapabilityForDelegation(delegation, statement);
      this.assertContainedByDelegation(delegation, requested);
      const response = await this.nativeInvoke(
        "sql",
        requested.path,
        "tinycloud.sql/read",
        { action: "execute_statement", name: statement.name, params: statement.fixedParams.map((item) => item.value) },
      );
      return parseNodeDataResponse(response, SqlReadResponseSchema, "SQL read") as TranscriptRequesterReadSqlResult;
    } catch (error) {
      this.recordAccessEnded(error);
      throw error;
    }
  }

  async readKv(path: string): Promise<TranscriptRequesterReadKvResult> {
    try {
      const delegation = await this.ensureFreshDelegation();
      const grantedKv = delegation.capabilities.find(
        (capability) => capability.service === "tinycloud.kv" && capability.path === path && capability.actions.includes("tinycloud.kv/get"),
      );
      const requested = parsePolicyCapability(
        {
          service: "tinycloud.kv",
          space: grantedKv?.space ?? "applications",
          path,
          actions: ["tinycloud.kv/get"],
        },
        "$.kvRead",
      );
      this.assertContainedByDelegation(delegation, requested);
      const response = await this.nativeInvoke("kv", path, "tinycloud.kv/get");
      return parseNodeDataResponse(response, KvReadResponseSchema, "KV read") as TranscriptRequesterReadKvResult;
    } catch (error) {
      this.recordAccessEnded(error);
      throw error;
    }
  }

  private async nativeInvoke(
    service: "sql" | "kv",
    path: string,
    action: "tinycloud.sql/read" | "tinycloud.kv/get",
    body?: unknown,
  ): Promise<RequesterHttpResponse> {
    const capability = this.invocationCapability;
    if (capability === undefined) {
      throw new TranscriptRequesterError(
        "requester-invocation-signer-required",
        "holder invocation capability is required for native reads",
      );
    }
    if (capability.holderDid !== this.requesterDid || capability.holderDid !== this.signingCapability?.holderDid) {
      throw new TranscriptRequesterError(
        "requester-invocation-signer-mismatch",
        "invocation signer must be the presentation key-binding holder",
      );
    }
    if (this.importedDelegationCid === undefined || this.importedDelegation === undefined) {
      throw new TranscriptRequesterError(
        "requester-delegation-import-failed",
        "native read requires a confirmed delegation import",
      );
    }
    const session: ServiceSession = {
      delegationHeader: { Authorization: this.importedDelegation.encoded! },
      delegationCid: this.importedDelegationCid,
      spaceId: this.bootstrap.ownerNode.spaceId,
      verificationMethod: capability.verificationMethod,
      jwk: capability.jwk,
    };
    const headers = headersRecord(capability.invoke(session, service, path, action));
    const response = await this.transport.request({
      method: "POST",
      url: `${trimTrailingSlash(this.bootstrap.ownerNode.endpoint)}/invoke`,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    this.assertOwnerNodeResponse(response, "/invoke");
    return response;
  }

  private async ensureFreshDelegation(): Promise<PortableDelegation> {
    if (this.accessEnded) {
      throw new TranscriptRequesterError(
        "requester-access-ended",
        "requester access has ended",
        "access-ended",
      );
    }
    if (this.importedDelegation !== undefined && !this.requiresRenewal(this.importedDelegation)) {
      return this.importedDelegation;
    }
    if (this.signingCapability === undefined || this.signingCapability.holderDid !== this.requesterDid) {
      throw new TranscriptRequesterError(
        "requester-renewal-required",
        "a permitted requester signing capability is required for access-triggered renewal",
        "renewal-required",
      );
    }
    try {
      let lastError: unknown;
      const attempts = Math.max(1, this.engineRetryAttempts);
      for (let attempt = 0; attempt < attempts; attempt++) {
        const challenge = await this.obtainChallenge();
        const presentation = await this.mintPresentation(challenge);
        try {
          const delegation = await this.resolveOnce(challenge, presentation);
          this.importedDelegation = delegation;
          return delegation;
        } catch (error) {
          if (!(error instanceof TranscriptRequesterError) || error.state !== "unreachable") {
            throw error;
          }
          lastError = error;
        }
        if (attempt + 1 < attempts) {
          await this.sleep(retryDelay(attempt, this.random()));
        }
      }
      throw new TranscriptRequesterError(
        "requester-engine-unreachable",
        lastError instanceof Error ? lastError.message : "policy engine unreachable",
        "unreachable",
      );
    } catch (error) {
      this.recordAccessEnded(error);
      throw error;
    }
  }

  private recordAccessEnded(error: unknown): void {
    if (error instanceof TranscriptRequesterError && error.state === "access-ended") {
      this.accessEnded = true;
    }
  }

  private async obtainChallenge(): Promise<z.infer<typeof ChallengeSchema>> {
    const response = await this.challengeRequestWithRetry({
      method: "POST",
      url: `${trimTrailingSlash(this.bootstrap.policyEngine.endpoint)}/policy/v0/challenge`,
      body: {
        policyId: this.bootstrap.policyId,
      },
    });
    return parseEngineSuccess(response.body, ChallengeResponseSchema, "challenge response").challenge;
  }

  private async mintPresentation(
    challenge: z.infer<typeof ChallengeSchema>,
  ): Promise<HolderKeyBindingPresentation> {
    if (
      challenge.policyId !== this.bootstrap.policyId ||
      challenge.audience !== this.bootstrap.policyEngine.audience ||
      challenge.audience !== this.audience
    ) {
      throw new TranscriptRequesterError(
        "requester-engine-response-invalid",
        "challenge response binding does not match requester context",
      );
    }
    if (this.usedChallengeNonces.has(challenge.nonce)) {
      throw new TranscriptRequesterError(
        "requester-challenge-reused",
        "challenge nonce was already used by this requester",
      );
    }
    this.usedChallengeNonces.add(challenge.nonce);
    const expiresAt = new Date(this.now().getTime() + this.presentationTtlSeconds * 1000)
      .toISOString()
      .replace(".000Z", "Z");
    const input = {
      schema: HOLDER_KEY_BINDING_PRESENTATION_SCHEMA,
      policyId: this.bootstrap.policyId,
      eligibleSubjectDid: this.eligibleSubjectDid,
      holderDid: this.requesterDid,
      holderBinding: this.holderBinding,
      requestedCapabilities: this.requestedCapabilities,
      requestedCapabilitiesHash: this.requestedCapabilitiesHash,
      audience: this.audience,
      nonce: challenge.nonce,
      expiresAt,
      ...(this.evidence === undefined ? {} : { evidence: this.evidence }),
    } as const;
    const signature =
      this.signingCapability!.signGrantPresentation === undefined
        ? await this.signingCapability!.signKeyBinding({
            ...input,
            challengeId: challenge.challengeId,
            issuedAt: expiresAt,
            keyId: this.signingCapability!.keyId,
          })
        : await this.signingCapability!.signGrantPresentation(input);
    if (typeof signature !== "string" || signature.length === 0) {
      throw new TranscriptRequesterError(
        "requester-presentation-invalid",
        "signing capability returned an invalid holder key-binding signature",
      );
    }
    return {
      ...input,
      holderSignature: {
        suite: this.signingCapability!.suite ?? challenge.acceptedSuites[0]!,
        signerDid: this.requesterDid,
        value: signature,
      },
    };
  }

  private async resolveOnce(
    challenge: z.infer<typeof ChallengeSchema>,
    presentation: HolderKeyBindingPresentation,
  ): Promise<PortableDelegation> {
    void challenge;
    const response = await this.resolveRequestOnce({
      method: "POST",
      url: `${trimTrailingSlash(this.bootstrap.policyEngine.endpoint)}/policy/v0/resolve`,
      body: { presentation },
    });
    const parsed = parseEngineSuccess(response.body, ResolveResponseSchema, "resolve response");
    return this.importPortableDelegation(parsed.delegation);
  }

  private async importPortableDelegation(input: unknown): Promise<PortableDelegation> {
    const parsed = normalizeWireDelegation(parseEngineSuccess(input, WireDelegationSchema, "portable delegation"));
    if (parsed.policyId !== this.bootstrap.policyId) {
      throw new TranscriptRequesterError(
        "requester-delegation-invalid",
        "portable delegation policy id does not match bootstrap",
      );
    }
    if (parsed.holderDid !== this.requesterDid) {
      throw new TranscriptRequesterError(
        "requester-delegation-wrong-holder",
        "portable delegation is not targeted at the requester DID",
      );
    }
    if (parsed.issuerDid !== this.grantIssuerDid) {
      throw new TranscriptRequesterError(
        "requester-delegation-invalid",
        "portable delegation issuer does not match the verified grant issuer DID",
      );
    }
    if (parsed.maxTtlSeconds > 300) {
      throw new TranscriptRequesterError(
        "requester-delegation-ttl-excessive",
        "portable delegation TTL exceeds 300 seconds",
      );
    }
    const issuedAt = parseStrictRfc3339(parsed.issuedAt)!;
    const expiresAt = parseStrictRfc3339(parsed.expiresAt)!;
    if (expiresAt <= issuedAt || expiresAt - issuedAt > parsed.maxTtlSeconds * 1000) {
      throw new TranscriptRequesterError(
        "requester-delegation-ttl-excessive",
        "portable delegation expires outside its maxTtlSeconds bound",
      );
    }
    const capabilities = parsed.capabilities.map((capability, index) =>
      parsePolicyCapability(capability, `$.delegation.capabilities[${index}]`),
    );
    for (const granted of capabilities) {
      if (!this.requestedCapabilities.some((requested) => policyCapabilityContains(requested, granted))) {
        throw new TranscriptRequesterError(
          "requester-delegation-capability-wider",
          "portable delegation grants a capability outside the bootstrap requested set",
        );
      }
    }
    if (typeof parsed.encoded !== "string" || parsed.encoded.split(".").length !== 3) {
      throw new TranscriptRequesterError("requester-delegation-invalid", "portable delegation is not a compact-JWS UCAN");
    }
    const delegation = { ...parsed, capabilities } as PortableDelegation;
    const response = await this.transport.request({
      method: "POST",
      url: `${trimTrailingSlash(this.bootstrap.ownerNode.endpoint)}/delegate`,
      headers: { Authorization: parsed.encoded },
    });
    this.assertOwnerNodeResponse(response, "/delegate");
    const receipt = parseDelegateReceipt(response);
    const target = this.bootstrap.ownerNode.spaceId;
    if (!receipt.activated.includes(target) || receipt.skipped.includes(target)) {
      throw new TranscriptRequesterError(
        "requester-delegation-import-failed",
        receipt.activated.includes(target) && receipt.skipped.includes(target)
          ? "owner node returned a contradictory delegation receipt"
          : "owner node did not activate the target owner space",
      );
    }
    this.importedDelegationCid = deriveDelegationCid(parsed.encoded);
    return delegation;
  }

  private assertOwnerNodeResponse(response: RequesterHttpResponse, path: string): void {
    const expected = `${trimTrailingSlash(this.bootstrap.ownerNode.endpoint)}${path}`;
    if (response.finalUrl !== expected || response.resolvedAddress === undefined) {
      throw new TranscriptRequesterError(
        "requester-owner-node-endpoint-invalid",
        "owner-node transport metadata is missing or indicates a redirect",
        "bootstrap-invalid",
      );
    }
    if (!this.ownerNodeAddresses.has(normalizeIp(response.resolvedAddress))) {
      throw new TranscriptRequesterError(
        "requester-owner-node-endpoint-invalid",
        "owner-node address changed after endpoint validation",
        "bootstrap-invalid",
      );
    }
  }

  private assertContainedByDelegation(
    delegation: PortableDelegation,
    requested: PolicyCapability,
  ): void {
    if (this.requiresRenewal(delegation)) {
      throw new TranscriptRequesterError(
        "requester-renewal-required",
        "delegation requires renewal before access",
        "renewal-required",
      );
    }
    if (!delegation.capabilities.some((granted) => policyCapabilityContains(granted, requested))) {
      throw new TranscriptRequesterError(
        "requester-access-not-contained",
        "requested access is outside the imported delegation capabilities",
        "not-contained",
      );
    }
  }

  private sqlAccessCapabilityForDelegation(
    delegation: PortableDelegation,
    statement: ListenSqlStatement,
  ): PolicyCapability {
    const grantedSql = delegation.capabilities.find(
      (capability) => capability.service === "tinycloud.sql" && capability.actions.includes("tinycloud.sql/read"),
    );
    if (grantedSql === undefined) {
      throw new TranscriptRequesterError("requester-access-not-contained", "delegation has no SQL read grant", "not-contained");
    }
    if (grantedSql.caveats !== undefined) {
      const statements = (grantedSql.caveats as { statements?: readonly { name?: unknown }[] }).statements;
      if (!statements?.some((candidate) => candidate.name === statement.name)) {
        throw new TranscriptRequesterError(
          "requester-access-not-contained",
          "SQL statement is outside the delegated named-statement caveat",
          "not-contained",
        );
      }
      return grantedSql;
    }
    return parsePolicyCapability(
      {
        service: "tinycloud.sql",
        space: grantedSql.space,
        path: grantedSql.path,
        actions: ["tinycloud.sql/read"],
      },
      "$.sqlRead",
    );
  }

  private requiresRenewal(delegation: PortableDelegation): boolean {
    const expiresAt = parseStrictRfc3339(delegation.expiresAt)!;
    return expiresAt - this.now().getTime() <= REQUESTER_NEAR_EXPIRY_SECONDS * 1000;
  }

  private async challengeRequestWithRetry(request: RequesterHttpRequest): Promise<RequesterHttpResponse> {
    let lastError: unknown;
    const attempts = Math.max(1, this.engineRetryAttempts);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.transport.request(request);
        if (response.status >= 500) {
          lastError = new Error(`engine returned ${response.status}`);
        } else if (response.status >= 400) {
          const denial = parseDenialBody(response.body);
          if (denial !== undefined) {
            throw errorForDenial(denial, response.status);
          }
          throw new TranscriptRequesterError(
            "requester-engine-response-invalid",
            "policy engine returned an invalid denial body",
          );
        } else {
          return response;
        }
      } catch (error) {
        if (error instanceof TranscriptRequesterError && error.state !== "unreachable") {
          throw error;
        }
        lastError = error;
      }
      if (attempt + 1 < attempts) {
        await this.sleep(retryDelay(attempt, this.random()));
      }
    }
    throw new TranscriptRequesterError(
      "requester-engine-unreachable",
      lastError instanceof Error ? lastError.message : "policy engine unreachable",
      "unreachable",
    );
  }

  private async resolveRequestOnce(request: RequesterHttpRequest): Promise<RequesterHttpResponse> {
    try {
      const response = await this.transport.request(request);
      if (response.status >= 500) {
        throw new TranscriptRequesterError(
          "requester-engine-unreachable",
          `engine returned ${response.status}`,
          "unreachable",
        );
      }
      if (response.status >= 400) {
        const denial = parseDenialBody(response.body);
        if (denial !== undefined) {
          throw errorForDenial(denial, response.status);
        }
        throw new TranscriptRequesterError(
          "requester-engine-response-invalid",
          "policy engine returned an invalid denial body",
        );
      }
      return response;
    } catch (error) {
      if (error instanceof TranscriptRequesterError) {
        throw error;
      }
      throw new TranscriptRequesterError(
        "requester-engine-unreachable",
        error instanceof Error ? error.message : "policy engine unreachable",
        "unreachable",
      );
    }
  }
}

export async function createTranscriptRequester(
  options: TranscriptRequesterOptions,
): Promise<TranscriptRequester> {
  return TranscriptRequester.create(options);
}

function parseBootstrap(input: unknown): TranscriptShareBootstrap & {
  readonly resourceHint: { readonly requestedCapabilities: readonly unknown[] };
} {
  const normalized = normalizeExternal(input, "requester-bootstrap-malformed");
  const parsed = BootstrapSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new TranscriptRequesterError(
      parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")
        ? "requester-bootstrap-unknown-key"
        : "requester-bootstrap-malformed",
      parsed.error.message,
      "bootstrap-invalid",
    );
  }
  return parsed.data as TranscriptShareBootstrap & {
    readonly resourceHint: { readonly requestedCapabilities: readonly unknown[] };
  };
}

async function verifyRecordBeforeEgress(
  bootstrap: TranscriptShareBootstrap,
  options: TranscriptRequesterOptions,
) {
  try {
    return await verifyPolicyEngineRecordForRequester({
      signedRecord: bootstrap.policyEngine.signedRecord,
      ownerDid: options.ownerDid,
      audience: options.audience,
      grantIssuerDid: options.grantIssuerDid,
      now: (options.now ?? (() => new Date()))().toISOString().replace(".000Z", "Z"),
      requiredPolicyVersion: POLICY_VERSION_V0,
      requiredEvidenceVerifier: W3C_VC_CREDENTIAL_VERIFIER,
    });
  } catch (error) {
    const code = errorCodeForRecordFailure(error);
    throw new TranscriptRequesterError(
      code,
      error instanceof Error ? error.message : String(error),
      "bootstrap-invalid",
    );
  }
}

function errorCodeForRecordFailure(error: unknown): TranscriptRequesterErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "policy-engine-record-signature-invalid") {
    return "requester-engine-record-signature-invalid";
  }
  if (code === "policy-engine-record-owner-mismatch") {
    return "requester-engine-record-owner-mismatch";
  }
  if (code === "policy-engine-record-audience-mismatch") {
    return "requester-engine-record-audience-mismatch";
  }
  return "requester-engine-record-invalid";
}

function parsePolicyCapability(input: unknown, path: string): PolicyCapability {
  try {
    return (normalizePolicyCapabilityForRequester(input) as unknown) as PolicyCapability;
  } catch (error) {
    throw new TranscriptRequesterError(
      "requester-delegation-invalid",
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function listenSqlStatementFromCatalog(statementName: unknown): ListenSqlStatement {
  if (typeof statementName !== "string") {
    throw new TranscriptRequesterError(
      "requester-access-not-contained",
      "SQL statement name must be a string from the canonical Listen statement catalog",
      "not-contained",
    );
  }
  const statement = LISTEN_SQL_STATEMENT_BY_NAME.get(statementName);
  if (statement === undefined) {
    throw new TranscriptRequesterError(
      "requester-access-not-contained",
      "SQL statement is not in the canonical Listen statement catalog",
      "not-contained",
    );
  }
  return statement;
}

function normalizePolicyCapabilityForRequester(input: unknown): PolicyCapability {
  const normalized = normalizeExternal(input, "requester-delegation-invalid");
  return normalizePolicyCapability(normalized);
}

function requestedCapabilitiesHash(capabilities: readonly PolicyCapability[]): string {
  const canonical = [...capabilities].sort((left, right) =>
    `${left.service}\0${left.space}\0${left.path}`.localeCompare(`${right.service}\0${right.space}\0${right.path}`),
  );
  const encoder = new TextEncoder();
  const domain = encoder.encode("xyz.tinycloud.policy/RequestedCapabilities/v0\0");
  const body = encoder.encode(jcsCanonicalize(canonical));
  const bytes = new Uint8Array(domain.length + body.length);
  bytes.set(domain, 0);
  bytes.set(body, domain.length);
  return bytesToHex(sha256(bytes, "bytes")).slice(2);
}

function normalizeWireDelegation(
  delegation: z.infer<typeof WireDelegationSchema>,
): NormalizedWireDelegation {
  const issuedAt = parseStrictRfc3339(delegation.issuedAt)!;
  const expiresAt = parseStrictRfc3339(delegation.expiresAt)!;
  return {
    delegationId: delegation.delegationId,
    issuerDid: delegation.issuerDid,
    holderDid: delegation.holderDid,
    policyId: delegation.policyId,
    issuedAt: delegation.issuedAt,
    expiresAt: delegation.expiresAt,
    terminal: delegation.terminal,
    maxTtlSeconds: Math.ceil((expiresAt - issuedAt) / 1000),
    capabilities: delegation.capabilities ?? capabilitiesFromCompactJws(delegation.encoded),
    encoded: delegation.encoded,
  };
}

function capabilitiesFromCompactJws(encoded: string): z.infer<typeof CapabilitySchema>[] {
  try {
    const parts = encoded.split(".");
    if (parts.length !== 3) throw new Error("not compact JWS");
    const payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1]!))) as {
      att?: Record<string, Record<string, readonly unknown[]>>;
    };
    if (payload.att === undefined) throw new Error("UCAN att is absent");
    const capabilities: z.infer<typeof CapabilitySchema>[] = [];
    for (const [resource, abilities] of Object.entries(payload.att)) {
      const marker = resource.indexOf("/sql/");
      if (!resource.startsWith("tinycloud:") || marker < 0) throw new Error("unsupported UCAN resource");
      const space = resource.slice(0, marker);
      const path = resource.slice(marker + "/sql/".length);
      for (const [action, caveats] of Object.entries(abilities)) {
        const service = action.startsWith("tinycloud.sql/")
          ? "tinycloud.sql"
          : action.startsWith("tinycloud.kv/")
            ? "tinycloud.kv"
            : undefined;
        if (service === undefined || caveats.length === 0) throw new Error("unsupported UCAN ability");
        const first = caveats[0];
        capabilities.push({
          service,
          space,
          path,
          actions: [action],
          ...(first !== null && typeof first === "object" && !Array.isArray(first) && Object.keys(first).length > 0
            ? { caveats: first as z.infer<typeof CapabilitySchema>["caveats"] }
            : {}),
        });
      }
    }
    if (capabilities.length === 0) throw new Error("UCAN att is empty");
    return capabilities;
  } catch (error) {
    throw new TranscriptRequesterError(
      "requester-delegation-invalid",
      `node-native compact-JWS capabilities are invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseEngineSuccess<T>(
  input: unknown,
  schema: z.ZodType<T>,
  label: string,
): T {
  const normalized = normalizeExternal(input, "requester-engine-response-invalid");
  const denial = parseDenialBody(normalized);
  if (denial !== undefined) {
    throw errorForDenial(denial);
  }
  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    throw new TranscriptRequesterError(
      "requester-engine-response-invalid",
      `${label} failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function parseDataResponse<T>(
  response: RequesterHttpResponse,
  schema: z.ZodType<T>,
  label: string,
): T {
  if (response.status >= 500) {
    throw new TranscriptRequesterError(
      "requester-access-unreachable",
      `${label} endpoint returned ${response.status}`,
      "unreachable",
    );
  }
  if (response.status >= 400) {
    const normalized = normalizeExternal(response.body, "requester-access-denied");
    const denial = parseDenialBody(normalized);
    if (denial !== undefined) {
      throw errorForDenial(denial, response.status);
    }
    throw new TranscriptRequesterError(
      "requester-access-denied",
      `${label} denied`,
      "denied",
    );
  }
  const normalized = normalizeExternal(response.body, "requester-engine-response-invalid");
  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    throw new TranscriptRequesterError(
      "requester-engine-response-invalid",
      `${label} response failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function parseDelegateReceipt(response: RequesterHttpResponse): z.infer<typeof DelegateReceiptSchema> {
  if (response.status !== 200) {
    throw new TranscriptRequesterError(
      "requester-delegation-import-failed",
      `owner node delegation import returned ${response.status}`,
      response.status >= 500 ? "invalid" : "denied",
      undefined,
      response.status,
    );
  }
  const normalized = normalizeExternal(response.body, "requester-delegation-import-failed");
  const parsed = DelegateReceiptSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new TranscriptRequesterError(
      "requester-delegation-import-failed",
      `owner node delegation receipt failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function parseNodeDataResponse<T>(
  response: RequesterHttpResponse,
  schema: z.ZodType<T>,
  label: string,
): T {
  if (response.status >= 500) {
    throw new TranscriptRequesterError(
      "requester-node-unreachable",
      `${label} node returned ${response.status}: ${nodeErrorMessage(response.body)}`,
      "unreachable",
      undefined,
      response.status,
    );
  }
  if (response.status >= 400) {
    throw new TranscriptRequesterError(
      "requester-node-denied",
      `${label} node denied: ${nodeErrorMessage(response.body)}`,
      "denied",
      undefined,
      response.status,
    );
  }
  const normalized = normalizeExternal(response.body, "requester-node-response-invalid");
  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    throw new TranscriptRequesterError(
      "requester-node-response-invalid",
      `${label} node response failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function nodeErrorMessage(body: unknown): string {
  if (typeof body === "string") return body;
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    const message = typeof record.message === "string" ? record.message : undefined;
    if (code !== undefined) return message === undefined ? code : `${code}: ${message}`;
  }
  return "native node refusal";
}

export function deriveDelegationCid(encoded: string): string {
  const digest = createDigest(0x1e, blake3(new TextEncoder().encode(encoded)));
  return CID.createV1(0x55, digest).toString();
}

function headersRecord(headers: ServiceHeaders): Record<string, string> {
  return Array.isArray(headers) ? Object.fromEntries(headers) : headers;
}

async function validateAndResolveOwnerNode(
  endpoint: string,
  transport: RequesterTransport,
): Promise<ReadonlySet<string>> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw ownerEndpointError("owner-node endpoint is not a URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw ownerEndpointError("owner-node endpoint must use HTTPS without credentials or fragments");
  }
  if (transport.resolveEndpoint === undefined) {
    throw ownerEndpointError("owner-node endpoint resolution metadata is required");
  }
  let resolution: RequesterEndpointResolution;
  try {
    resolution = await transport.resolveEndpoint(url.origin);
  } catch (error) {
    throw ownerEndpointError(`owner-node endpoint resolution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (resolution.addresses.length === 0) {
    throw ownerEndpointError("owner-node endpoint resolved to no addresses");
  }
  const addresses = new Set<string>();
  for (const address of resolution.addresses) {
    const normalized = normalizeIp(address);
    if (!isPublicIp(normalized)) {
      throw ownerEndpointError(`owner-node endpoint resolved to a non-public address: ${address}`);
    }
    addresses.add(normalized);
  }
  return addresses;
}

function ownerEndpointError(message: string): TranscriptRequesterError {
  return new TranscriptRequesterError(
    "requester-owner-node-endpoint-invalid",
    message,
    "bootstrap-invalid",
  );
}

function normalizeIp(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "");
}

function isPublicIp(value: string): boolean {
  const ip = normalizeIp(value);
  const parts = ip.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255)) {
    const [a, b] = parts.map(Number) as [number, number, number, number];
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && parts[2] === "100") ||
      (a === 203 && b === 0 && parts[2] === "113") ||
      a >= 224
    );
  }
  if (!ip.includes(":")) return false;
  if (ip === "::" || ip === "::1" || ip.startsWith("2001:db8:") || ip.startsWith("fe8") || ip.startsWith("fe9") ||
      ip.startsWith("fea") || ip.startsWith("feb") || ip.startsWith("fc") || ip.startsWith("fd") ||
      ip.startsWith("ff")) return false;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped !== null) return isPublicIp(mapped[1]!);
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex !== null) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    return isPublicIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return true;
}

function parseDenialBody(input: unknown): { code: PolicyEngineGrantPresentationDenialCode; message?: string } | undefined {
  const normalized = normalizeExternal(input, "requester-engine-response-invalid");
  const direct = DenialSchema.safeParse(normalized);
  if (direct.success) {
    return { code: direct.data.code, message: direct.data.message };
  }
  const envelope = ErrorEnvelopeDenialSchema.safeParse(normalized);
  if (envelope.success) {
    return { code: envelope.data.error.code, message: envelope.data.error.message };
  }
  return undefined;
}

function errorForDenial(
  denial: { code: PolicyEngineGrantPresentationDenialCode; message?: string },
  status?: number,
): TranscriptRequesterError {
  const accessEnded =
    denial.code === "policy-inactive" ||
    denial.code === "policy-revoked" ||
    denial.code === "policy-expired";
  return new TranscriptRequesterError(
    `policy-engine-denied-${denial.code}`,
    denial.message ?? `policy engine denied ${denial.code}`,
    accessEnded ? "access-ended" : "denied",
    denial.code,
    status,
  );
}

function retryDelay(attempt: number, random: number): number {
  const base = Math.min(REQUESTER_ENGINE_RETRY_MAX_DELAY_MS, 50 * 2 ** attempt);
  return Math.min(REQUESTER_ENGINE_RETRY_MAX_DELAY_MS, Math.floor(base * (0.5 + random)));
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeExternal(
  input: unknown,
  code: TranscriptRequesterErrorCode,
): unknown {
  try {
    return normalizeJson(input);
  } catch (error) {
    throw new TranscriptRequesterError(
      code,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseStrictRfc3339(value: string): number | undefined {
  if (
    !/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  const canonical = new Date(parsed).toISOString().replace(".000Z", "Z");
  const reparsed = Date.parse(value);
  return Date.parse(canonical) === reparsed ? parsed : undefined;
}
