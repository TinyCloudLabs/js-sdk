import { sameTinyCloudNode } from "@tinycloud/sdk-core";
import { admitOwnerRenewalLease, RENEWAL_LEASE_ORIGINAL_EXPIRED, RENEWAL_RENEWER_CHANGED } from "@tinycloud/sdk-core/delegations/renewal";
import { RENEWAL_ADMISSION_LEAD_MS, verifyOwnerRenewalLease } from "@tinycloud/sdk-core/delegations/renewal-receipt";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  activateValidatedRuntimeDelegation,
  deserializeDelegation,
  InvalidRestoredSessionError,
  RuntimeDelegationRejectedError,
  serializeDelegation,
  TinyCloudNode,
  UnsupportedSessionRestoreError,
  isCapabilitySubset,
  principalDidEquals,
  RUNTIME_DELEGATION_REJECTIONS,
  siweRuntimeDelegation,
  signedCompactUcanExpiry,
  type PermissionEntry,
  type PortableDelegation,
  type TinyCloudSession,
} from "@tinycloud/node-sdk";
import { TCWSessionManager, importKey, initPanicHook } from "@tinycloud/node-sdk-wasm";
import { createOrReusePermissionRequest } from "@tinycloud/operations/artifacts";
import { withTinyCloudStateRoot } from "@tinycloud/operations/state";
import { invokeOperation } from "@tinycloud/operations";
import { liveStoredLease, restoreStoredSession } from "@tinycloud/operations/profile";
import { nodeRevocationOf, operationRetryDescriptor, type NodeRevocation } from "@tinycloud/operations/mcp-authority";
import { tcAppsApprovalMessage, tcAppsApprovalReason } from "@tinycloud/operations/tc-apps";
import {
  APPROVAL_POLL_INTERVAL_MS,
  DEFAULT_LINKS_API_ORIGIN,
  isApprovalClientError,
  type ApprovalClientError,
  type ApprovalRenewal,
} from "@tinycloud/share-envelope/links";
import { nativeOwnerForConnectorGrant, canonicalOwnerDid, NATIVE_GRANT_MAX_LIFETIME_SECONDS } from "./native-auth.js";
import {
  ackOpenKeyResult,
  collectOpenKeyResult,
  createOpenKeyRequest,
  lifetimeSeconds,
  type OpenKeyCollection,
  type OpenKeyEndpoints,
  type OpenKeyRequestState,
} from "./openkey-approval.js";

import type { McpOperationInvocation } from "./tools.js";
const PROFILE = "agent";
const MAX_CALLBACK_BYTES = 256 * 1024;
const PENDING_VERSION = 2;
/** How long a call waits on OpenKey for one approval result. */
const CALL_COLLECTION_TIMEOUT_MS = 3_000;
/** How long a call waits for all of its tenant's approval results; the rest continue in the background. */
const CALL_COLLECTION_BUDGET_MS = 3_000;
const POLL_COLLECTION_TIMEOUT_MS = 10_000;
/** Background polls run every 2 s for the first minute, then every 10 s. */
const FAST_POLL_WINDOW_MS = 60_000;
const SLOW_POLL_INTERVAL_MS = 10_000;
/** Approvals polled in the background at once; beyond this, calls collect. */
const MAX_COLLECTION_POLLS = 64;
/** How long after its request ends a result may still be collected (OpenKey keeps it 10 minutes). */
const RESULT_COLLECTION_GRACE_MS = 600_000;
/** A claimed result left by a stopped server becomes collectable again after this. */
const PROCESSING_STALE_MS = 120_000;
/**
 * The renewal lease every approval asks for, connection or scoped. The owner may approve without it;
 * then the grant ends at its signed end and is approved again.
 */
export const BOOTSTRAP_LEASE_SECONDS = 90 * 86_400;
/**
 * A tenant with no authenticated call for this long loses its key, session, grants and pending
 * approvals; its next call starts over with a new key and a fresh connection approval. A removed
 * OpenKey connection makes no further authenticated calls, so its authority ends within this time.
 */
export const TENANT_IDLE_MS = 30 * 86_400_000;
/** The first idle sweep runs this long after start, then every `IDLE_SWEEP_INTERVAL_MS`. */
const IDLE_SWEEP_DELAY_MS = 60_000;
const IDLE_SWEEP_INTERVAL_MS = 6 * 3_600_000;
/** How often a tenant's calls touch its call marker, which the idle sweep reads after a restart. */
const CALL_MARK_INTERVAL_MS = 3_600_000;
const NATIVE_GRANT_IMPORT_REJECTION_CODES = new Set([
  "DELEGATION_ARTIFACT_INVALID",
  "DELEGATION_EXPIRED",
  "DELEGATION_AUDIENCE_MISMATCH",
  "DELEGATION_HOST_MISMATCH",
  "DELEGATION_REJECTED",
]);
const PRODUCTION_NODE_HOSTS = new Set(["https://node.tinycloud.xyz", "https://tee.node.tinycloud.xyz"]);
const BOOTSTRAP_PERMISSIONS: PermissionEntry[] = [
  {
    service: "tinycloud.kv",
    space: "account",
    path: "spaces/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
  },
  {
    service: "tinycloud.kv",
    space: "account",
    path: "applications/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
  },
];

export interface RemoteStoreConfig {
  readonly stateDir: string;
  readonly stateSecret: string;
  readonly publicUrl: URL;
  /** Separate public-plugin approvals from the existing root approval link. */
  readonly approvalPath?: string;
  readonly nodeHost: string;
  /** OpenKey web origin approval links open on. */
  readonly openkeyHost: string;
  /**
   * OpenKey API origin approval results are fetched from. Defaults to
   * `https://api.openkey.so` for `https://openkey.so`, else `openkeyHost`.
   */
  readonly openkeyApiHost?: string;
  /** Links API origin that stores signed approval requests. */
  readonly linksApiOrigin?: string;
  readonly approvalTtlSeconds: number;
  readonly delegationExpiry: string;
  /** Shared secret used only by the Exo native client, never logged. */
  readonly nativeServiceCredential?: string;
}

interface TenantProfile {
  readonly stateRoot: string;
  readonly sessionDid: string;
  readonly jwk: Record<string, unknown>;
  readonly approvalEpoch: number;
}
interface NativeServiceKey {
  readonly version: 1;
  readonly jwk: Record<string, unknown>;
}

interface StoredNativeGrant {
  readonly version: 1;
  readonly ownerDid: string;
  readonly serviceDid: string;
  readonly serializedDelegation: string;
  readonly delegationCid: string;
  readonly spaceId: string;
  readonly permissions: PermissionEntry[];
  readonly expiresAt: string;
}

export type NativeGrantLookup =
  | { readonly status: "ok"; readonly ownerDid: string; readonly stateRoot: string; readonly expiresAt: string }
  | { readonly status: "required" | "expired" | "rejected" | "unavailable" };

export interface NativeServiceIdentity {
  readonly serviceDid: string;
}

interface PendingApproval {
  readonly version: 2;
  readonly nonce: string;
  readonly tenantId: string;
  readonly kind: "bootstrap" | "delegation";
  /** The operations authority request a scoped approval answers. */
  readonly requestId?: string;
  readonly permissions: PermissionEntry[];
  readonly ownerDids: string[];
  readonly createdAt: string;
  readonly approvalEpoch: number;
  readonly expiresAt: string;
  /** The OpenKey approval request, once the link was first opened. */
  readonly openkey?: OpenKeyRequestState;
  /** When a collection claimed this approval's result; only claimed files carry it. */
  readonly claimedAt?: string;
}

/** What one collection attempt left: keep polling, retry later, finished, or nothing to collect. */
type CollectionOutcome = "pending" | "retry" | "done" | "idle";

export interface ConnectStatus {
  readonly connected: boolean;
  readonly sessionDid: string;
  readonly approvalUrl?: string;
  readonly expiresAt?: string;
}

type SessionState = "valid" | "invalid" | "unknown";

interface CallbackSession {
  readonly delegationHeader: { Authorization: string };
  readonly delegationCid: string;
  readonly spaceId: string;
  readonly jwk: Record<string, unknown>;
  readonly verificationMethod: string;
  readonly address: string;
  readonly chainId: number;
  readonly siwe: string;
  readonly signature: string;
}

/**
 * The approving wallet is not the OpenKey principal whose MCP request created
 * the approval link. The message is static so callers may show it verbatim.
 */
export class ApprovalOwnerMismatchError extends Error {
  constructor() {
    super("This approval link was requested by a different TinyCloud account, so the delegation was not stored.");
    this.name = "ApprovalOwnerMismatchError";
  }
}

/** The stages that can refuse a collected approval. */
export type ApprovalStage = "restore_approval" | "siwe_runtime_delegation" | "auth_import" | "activation" | "renewal";

/**
 * A stage refused the approval. `code` and `reason` are server-authored
 * identifiers for diagnostics; the message and cause may quote OpenKey or node
 * data and are never sent or logged.
 */
export class ApprovalStageError extends Error {
  readonly stage: ApprovalStage;
  readonly code: string;
  readonly reason: string | undefined;

  constructor(stage: ApprovalStage, code: string, reason?: string, cause?: unknown) {
    super(`The approval failed at ${stage} (${code}).`, { cause });
    this.name = "ApprovalStageError";
    this.stage = stage;
    this.code = code;
    this.reason = reason;
  }
}

/**
 * The node could not be reached or did not answer while admitting an approved renewal lease. The
 * approval is kept and admitted again on the next collection; admission replays the same signed lease.
 */
class RenewalAdmissionUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The renewal lease could not be admitted yet.", { cause });
    this.name = "RenewalAdmissionUnavailableError";
  }
}

/** Why an approval link was refused before its approval was read. */
export type ApprovalRequestDetail =
  | "state_missing"
  | "state_invalid"
  | "state_expired"
  | "state_not_pending"
  | "tenant_missing";

/**
 * The link's state or tenant was refused before the approval was read.
 * `detail` is for server diagnostics only: callers get one uniform response
 * so they cannot probe whether a state is valid.
 */
export class ApprovalRequestError extends Error {
  readonly detail: ApprovalRequestDetail;

  constructor(detail: ApprovalRequestDetail, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ApprovalRequestError";
    this.detail = detail;
  }
}

/** OpenKey could not store the approval request, so there is no link to open yet. */
export class ApprovalLinkUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The approval link could not be created.", { cause });
    this.name = "ApprovalLinkUnavailableError";
  }
}
export class NativeGrantValidationError extends Error {
  readonly code:
    | "native_grant_required"
    | "native_grant_expired"
    | "native_grant_rejected"
    | "native_grant_validation_unavailable"
    | "native_service_unavailable";

  constructor(
    status: "required" | "expired" | "rejected" | "unavailable" |
      "native_grant_required" | "native_grant_expired" | "native_grant_rejected" |
      "native_grant_validation_unavailable" | "native_service_unavailable",
  ) {
    const code = status.startsWith("native_")
      ? status as NativeGrantValidationError["code"]
      : status === "required"
        ? "native_grant_required"
        : status === "expired"
          ? "native_grant_expired"
          : status === "unavailable"
            ? "native_grant_validation_unavailable"
            : "native_grant_rejected";
    super(code);
    this.name = "NativeGrantValidationError";
    this.code = code;
  }
}

export class RemoteTenantStore {
  readonly #config: RemoteStoreConfig;
  readonly #initializing = new Map<string, Promise<TenantProfile>>();
  readonly #sessionChecks = new Map<string, Promise<SessionState>>();
  readonly #clearing = new Map<string, Promise<void>>();
  readonly #activeSessions = new Map<string, { cids: string; until: number }>();
  readonly #pendingWrites = new Map<string, Promise<PendingApproval>>();
  readonly #renewalRequired = new Set<string>();
  readonly #approvalEpochs = new Map<string, number>();
  readonly #scopedClearing = new Map<string, Promise<void>>();
  readonly #clearedScoped = new Map<string, Set<string>>();
  readonly #approvalProcessing = new Map<string, Promise<void>>();
  readonly #linkCreations = new Map<string, Promise<string>>();
  readonly #collections = new Map<string, Promise<CollectionOutcome>>();
  readonly #polls = new Map<string, NodeJS.Timeout>();
  /** state root -> last authenticated call in this process (ms). */
  readonly #lastCalls = new Map<string, number>();
  /** state root -> when this process last touched the tenant's call marker (ms). */
  readonly #callMarks = new Map<string, number>();
  readonly #idleRemovals = new Map<string, Promise<void>>();
  #sweepTimer?: NodeJS.Timeout;
  #sweeping?: Promise<number>;
  #closed = false;
  readonly #endpoints: OpenKeyEndpoints;
  readonly #grantLifetimeSeconds: number;
  #nativeIdentity?: Promise<{ did: string; jwk: Record<string, unknown> }>;
  readonly #nativeGrantQueues = new Map<string, Promise<void>>();

  constructor(config: RemoteStoreConfig) {
    this.#config = config;
    const openkeyOrigin = new URL(config.openkeyHost).origin;
    this.#endpoints = {
      openkeyOrigin,
      openkeyApiOrigin: new URL(
        config.openkeyApiHost ?? (openkeyOrigin === "https://openkey.so" ? "https://api.openkey.so" : openkeyOrigin),
      ).origin,
      linksApiOrigin: new URL(config.linksApiOrigin ?? DEFAULT_LINKS_API_ORIGIN).origin,
    };
    this.#grantLifetimeSeconds = lifetimeSeconds(config.delegationExpiry);
    this.#scheduleSweep(IDLE_SWEEP_DELAY_MS);
  }

  #scheduleSweep(delay: number): void {
    this.#sweepTimer = setTimeout(() => {
      void this.sweepIdleTenants()
        .catch(() => writeDiagnostic("idle sweep failed"))
        .finally(() => {
          if (!this.#closed) this.#scheduleSweep(IDLE_SWEEP_INTERVAL_MS);
        });
    }, delay);
    this.#sweepTimer.unref();
  }

  async nativeServiceIdentity(): Promise<NativeServiceIdentity> {
    const identity = await this.#loadNativeServiceKey();
    return { serviceDid: normalizeDid(identity.did) };
  }

  nativeTenantStateRoot(ownerDid: string): string {
    const canonical = canonicalOwnerDid(ownerDid);
    if (canonical === undefined) throw new NativeGrantValidationError("rejected");
    const tenant = createHmac("sha256", this.#config.stateSecret)
      .update(`native-tenant:${canonical}`)
      .digest("hex");
    return join(this.#config.stateDir, "native-tenants", tenant);
  }

  async acceptNativeGrant(serializedDelegation: string): Promise<{
    ownerDid: string;
    serviceDid: string;
    expiresAt: string;
    stateRoot: string;
  }> {
    if (Buffer.byteLength(serializedDelegation) > MAX_CALLBACK_BYTES) {
      throw new NativeGrantValidationError("rejected");
    }
    const identity = await this.#loadNativeServiceKey();
    const activated = await this.#activateNativeDelegation(serializedDelegation, identity);
    const { ownerDid, spaceId, permissions, expiresAt } = activated;
    return this.#withNativeGrantLock(ownerDid, async () => {
      const stateRoot = this.nativeTenantStateRoot(ownerDid);
      let previous: StoredNativeGrant | null = null;
      try {
        const stored = await readJson<unknown>(this.#nativeGrantPath(stateRoot));
        if (isRecord(stored) && stored.version === 1 && stored.ownerDid === ownerDid &&
          typeof stored.serviceDid === "string" && samePrincipal(stored.serviceDid, identity.did) &&
          typeof stored.serializedDelegation === "string" && typeof stored.delegationCid === "string" &&
          typeof stored.spaceId === "string" && Array.isArray(stored.permissions) &&
          stored.permissions.every(isPermissionEntry) &&
          nativeOwnerForConnectorGrant(stored.permissions) === ownerDid &&
          typeof stored.expiresAt === "string" && Number.isFinite(Date.parse(stored.expiresAt))) {
          previous = stored as unknown as StoredNativeGrant;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (previous !== null) {
        const previousExpiry = Date.parse(previous.expiresAt);
        const nextExpiry = expiresAt.getTime();
        if (previousExpiry > nextExpiry ||
          (previousExpiry === nextExpiry && previous.delegationCid !== activated.cid)) {
          throw new NativeGrantValidationError("rejected");
        }
        if (previous.delegationCid === activated.cid) {
          return {
            ownerDid,
            serviceDid: normalizeDid(identity.did),
            expiresAt: previous.expiresAt,
            stateRoot,
          };
        }
      }
      const session = {
        delegationHeader: activated.delegation.delegationHeader,
        delegationCid: activated.cid,
        spaceId,
        jwk: identity.jwk,
        verificationMethod: identity.did,
        tinycloudHosts: [this.#config.nodeHost],
      };
      const grant: StoredNativeGrant = {
        version: 1,
        ownerDid,
        serviceDid: normalizeDid(identity.did),
        serializedDelegation: serializeDelegation(activated.delegation),
        delegationCid: activated.cid,
        spaceId,
        permissions,
        expiresAt: expiresAt.toISOString(),
      };
      const sessionPath = this.#sessionPath(stateRoot);
      const previousSession = await readOptionalText(sessionPath);
      try {
        await secureWrite(this.#profilePath(stateRoot), {
          name: PROFILE,
          host: this.#config.nodeHost,
          chainId: activated.delegation.chainId,
          spaceName: "applications",
          did: identity.did,
          createdAt: new Date().toISOString(),
          profile: PROFILE,
          operatorType: "agent",
          posture: "delegate-session",
          ownerDid,
          sessionDid: identity.did,
          spaceId,
          tinycloudHost: this.#config.nodeHost,
        });
        await secureWrite(this.#keyPath(stateRoot), identity.jwk);
        await secureWrite(sessionPath, session);
        const request = await withTinyCloudStateRoot(stateRoot, () => createOrReusePermissionRequest({
          profile: PROFILE,
          posture: "delegate-session",
          operatorType: "agent",
          host: this.#config.nodeHost,
          sessionDid: identity.did,
          ownerDid,
          spaceId,
          missing: permissions,
          granted: [],
          replace: true,
        }));
        if (request.status !== "created") {
          throw new NativeGrantValidationError("native_grant_validation_unavailable");
        }
        const imported = await invokeOperation(
          "tinycloud.auth.import",
          1,
          { profile: PROFILE, stateRoot },
          {
            kind: "tinycloud.auth.delegation",
            version: 1,
            requestId: request.request.requestId,
            delegationCid: activated.cid,
            delegation: activated.delegation,
          },
        );
        if (imported.status === "error") {
          throw new NativeGrantValidationError(
            NATIVE_GRANT_IMPORT_REJECTION_CODES.has(imported.error.code)
              ? "native_grant_rejected"
              : "native_grant_validation_unavailable",
          );
        }
        if (imported.status !== "ok" || !isRecord(imported.output) ||
          imported.output.activated !== true || imported.output.cid !== activated.cid) {
          throw new NativeGrantValidationError("native_grant_validation_unavailable");
        }
        await secureWrite(this.#nativeGrantPath(stateRoot), grant);
      } catch (error) {
        try {
          await restoreOptionalText(sessionPath, previousSession);
        } catch {
          await rm(this.#nativeGrantPath(stateRoot), { force: true }).catch(() => undefined);
          throw new NativeGrantValidationError("native_grant_validation_unavailable");
        }
        throw error;
      }
      return { ownerDid, serviceDid: normalizeDid(identity.did), expiresAt: grant.expiresAt, stateRoot };
    });
  }

  async nativeGrantForOwner(ownerDid: string): Promise<NativeGrantLookup> {
    const canonical = canonicalOwnerDid(ownerDid);
    if (canonical === undefined) return { status: "rejected" };
    const stateRoot = this.nativeTenantStateRoot(canonical);
    let stored: StoredNativeGrant | null;
    try {
      stored = await readJson<StoredNativeGrant>(this.#nativeGrantPath(stateRoot));
    } catch {
      return { status: "rejected" };
    }
    if (stored === null) return { status: "required" };
    if (!isRecord(stored) || stored.version !== 1 || stored.ownerDid !== canonical ||
      typeof stored.serviceDid !== "string" || typeof stored.serializedDelegation !== "string" ||
      typeof stored.delegationCid !== "string" || typeof stored.spaceId !== "string" ||
      typeof stored.expiresAt !== "string" || !Array.isArray(stored.permissions) ||
      !stored.permissions.every(isPermissionEntry) ||
      nativeOwnerForConnectorGrant(stored.permissions) !== canonical) {
      return { status: "rejected" };
    }
    const expires = Date.parse(stored.expiresAt);
    if (!Number.isFinite(expires)) return { status: "rejected" };
    if (expires <= Date.now()) return { status: "expired" };
    try {
      const identity = await this.#loadNativeServiceKey();
      if (!samePrincipal(stored.serviceDid, identity.did)) return { status: "rejected" };
      const activated = await this.#activateNativeDelegation(stored.serializedDelegation, identity);
      if (activated.ownerDid !== canonical || activated.cid !== stored.delegationCid ||
        activated.spaceId !== stored.spaceId ||
        JSON.stringify(activated.permissions) !== JSON.stringify(stored.permissions) ||
        activated.expiresAt.toISOString() !== stored.expiresAt) return { status: "rejected" };
      return { status: "ok", ownerDid: canonical, stateRoot, expiresAt: stored.expiresAt };
    } catch (error) {
      if (error instanceof NativeGrantValidationError) {
        return { status: error.code === "native_grant_expired" ? "expired" :
          error.code === "native_grant_validation_unavailable" ? "unavailable" : "rejected" };
      }
      return { status: "unavailable" };
    }
  }

  async assertNativeGrantActive(ownerDid: string): Promise<void> {
    const canonical = canonicalOwnerDid(ownerDid);
    if (canonical === undefined) throw new NativeGrantValidationError("rejected");
    const stateRoot = this.nativeTenantStateRoot(canonical);
    let stored: StoredNativeGrant | null;
    try {
      stored = await readJson<StoredNativeGrant>(this.#nativeGrantPath(stateRoot));
    } catch {
      throw new NativeGrantValidationError("rejected");
    }
    if (stored === null) throw new NativeGrantValidationError("required");
    if (!isRecord(stored) || stored.version !== 1 || stored.ownerDid !== canonical ||
      typeof stored.expiresAt !== "string" || !Number.isFinite(Date.parse(stored.expiresAt))) {
      throw new NativeGrantValidationError("rejected");
    }
    if (Date.parse(stored.expiresAt) <= Date.now()) throw new NativeGrantValidationError("expired");
  }

  tenantStateRoot(subject: string): string {
    return join(this.#config.stateDir, "tenants", this.#tenantId(subject));
  }

  /** Prepare only this authenticated account's profile before its first operation. */
  async initializeTenant(subject: string): Promise<string> {
    return (await this.#ensureTenant(subject)).stateRoot;
  }
  /** Check stored node authority before an authenticated operation uses it. */
  async validateTenant(subject: string, ownerDids: readonly string[]): Promise<void> {
    const tenant = await this.#ensureTenant(subject);
    await this.#collectApprovals(tenant);
    await this.#hasValidSession(tenant, ownerDids);
  }

  async connectStatus(subject: string, ownerDids: readonly string[] = []): Promise<ConnectStatus> {
    const tenant = await this.#ensureTenant(subject);
    await this.#collectApprovals(tenant);
    const state = await this.#sessionState(tenant, ownerDids, true);
    if (state === "valid") return { connected: true, sessionDid: tenant.sessionDid };
    // An unconfirmed session is not connected, but no new approval is issued for it.
    if (state === "unknown") return { connected: false, sessionDid: tenant.sessionDid };
    const pending = await this.#createPending(subject, ownerDids, "bootstrap", BOOTSTRAP_PERMISSIONS);
    return {
      connected: false,
      sessionDid: tenant.sessionDid,
      approvalUrl: this.#connectUrl(pending),
      expiresAt: pending.expiresAt,
    };
  }

  async decorateAuthorityResult(
    subject: string,
    ownerDids: readonly string[],
    result: unknown,
    invocation?: McpOperationInvocation,
  ): Promise<unknown> {
    if (!isRecord(result)) return result;
    if (result.status === "error" && isRecord(result.error) &&
      (result.error.code === "SESSION_NOT_FOUND" || result.error.code === "AUTH_REQUIRED")) {
      const tenant = await this.#ensureTenant(subject);
      const refusal = revocationFromResult(result.error);
      const cleared = refusal === undefined ? undefined : await this.#clearRefusedAuthority(tenant, refusal);
      if (cleared === "scoped" && invocation !== undefined) {
        return this.#renewScopedApproval(subject, ownerDids, tenant, result, invocation);
      }
      const valid = await this.#hasValidSession(tenant, ownerDids, true);
      if (valid && result.error.code === "AUTH_REQUIRED") {
        if (refusal === undefined) return result;
        return {
          ...result,
          error: { code: "AUTH_REQUIRED", message: "TinyCloud approval is required.", retryable: false },
        };
      }
      const pending = await this.#createPending(subject, ownerDids, "bootstrap", BOOTSTRAP_PERMISSIONS);
      return {
        status: "error",
        operation: result.operation,
        context: result.context,
        error: {
          code: result.error.code === "SESSION_NOT_FOUND" &&
            await readJson<unknown>(this.#sessionPath(tenant.stateRoot)) === null
            ? "SESSION_NOT_FOUND"
            : "AUTH_REQUIRED",
          message: "A new TinyCloud approval is required.",
          retryable: false,
          details: { approvalUrl: this.#connectUrl(pending), expiresAt: pending.expiresAt },
        },
      };
    }
    if (result.status !== "authority_required") return result;
    const tenant = await this.#ensureTenant(subject);
    if (this.#renewalRequired.has(tenant.stateRoot) ||
      !(await this.#hasValidSession(tenant, ownerDids, true))) {
      if (this.#renewalRequired.has(tenant.stateRoot)) {
        const pending = await this.#createPending(subject, ownerDids, "bootstrap", BOOTSTRAP_PERMISSIONS);
        return {
          status: "error",
          operation: result.operation,
          context: result.context,
          error: {
            code: "AUTH_REQUIRED",
            message: "A new TinyCloud approval is required.",
            retryable: false,
            details: { approvalUrl: this.#connectUrl(pending), expiresAt: pending.expiresAt },
          },
        };
      }
    }
    const request = isRecord(result.request) ? result.request : undefined;
    const requestId = typeof request?.requestId === "string" ? request.requestId : undefined;
    const requested = Array.isArray(request?.requested)
      ? request.requested.filter(isPermissionEntry)
      : [];
    if (requestId === undefined || requested.length === 0) return result;
    const pending = await this.#createPending(subject, ownerDids, "delegation", requested, requestId);
    return {
      ...result,
      approval: {
        ...(isRecord(result.approval) ? result.approval : {}),
        kind: "openkey",
        requestId,
        url: this.#connectUrl(pending),
        fallback: tcAppsApprovalMessage(requested) ??
          "Open the approval URL, then retry the same MCP tool.",
      },
    };
  }

  async #renewScopedApproval(
    subject: string,
    ownerDids: readonly string[],
    tenant: TenantProfile,
    result: Record<string, unknown>,
    invocation: McpOperationInvocation,
  ): Promise<unknown> {
    const planned = await invokeOperation(
      "tinycloud.auth.request",
      1,
      { profile: PROFILE, stateRoot: tenant.stateRoot },
      invocation,
    );
    const output = planned.status === "ok" && isRecord(planned.output) ? planned.output : undefined;
    const request = isRecord(output?.request) ? output.request : undefined;
    const requestId = typeof request?.requestId === "string" ? request.requestId : undefined;
    const requested = Array.isArray(request?.requested)
      ? request.requested.filter(isPermissionEntry)
      : [];
    const missing = Array.isArray(output?.missing) ? output.missing.filter(isPermissionEntry) : [];
    if (requestId === undefined || requested.length === 0 || missing.length === 0) {
      return {
        status: "error",
        operation: result.operation,
        context: result.context,
        error: { code: "AUTH_REQUIRED", message: "A new TinyCloud approval is required.", retryable: false },
      };
    }
    const pending = await this.#createPending(subject, ownerDids, "delegation", requested, requestId);
    return {
      status: "authority_required",
      operation: result.operation,
      context: result.context,
      missing,
      request,
      approval: {
        kind: "openkey",
        requestId,
        url: this.#connectUrl(pending),
        fallback: tcAppsApprovalMessage(requested) ??
          "Open the approval URL, then retry the same MCP tool.",
      },
      retry: operationRetryDescriptor(invocation, invocation.input),
    };
  }

  async #clearRefusedAuthority(
    tenant: TenantProfile,
    refusal: NodeRevocation,
  ): Promise<"bootstrap" | "scoped" | undefined> {
    const raw = await readJson<Record<string, unknown>>(this.#sessionPath(tenant.stateRoot)).catch(() => null);
    const bootstrapCid = raw?.delegationCid;
    const ancestorCid = refusal.reason === "delegation_ancestor_revoked" ? refusal.ancestorCid : undefined;
    if (typeof bootstrapCid === "string" &&
      (bootstrapCid === refusal.revokedCid || bootstrapCid === ancestorCid)) {
      await this.#clearAuthority(tenant);
      return "bootstrap";
    }
    const key = tenant.stateRoot;
    const removed = this.#clearedScoped.get(tenant.stateRoot);
    if (removed?.has(refusal.revokedCid)) return "scoped";
    const additional = await readJson<unknown>(this.#additionalPath(tenant.stateRoot));
    if (this.#clearedScoped.get(key)?.has(refusal.revokedCid)) return "scoped";
    if (!Array.isArray(additional)) return undefined;
    const affected = additional.some((entry) => {
      const cid = isRecord(entry) && isRecord(entry.delegation) ? entry.delegation.cid : undefined;
      return typeof cid === "string" && (cid === refusal.revokedCid || cid === ancestorCid);
    });
    const inProgress = this.#scopedClearing.get(key);
    if (inProgress) {
      await inProgress;
      return this.#clearRefusedAuthority(tenant, refusal);
    }
    if (!affected) return undefined;
    const clearing = (async () => {
      const latest = await readJson<unknown>(this.#additionalPath(tenant.stateRoot));
      if (!Array.isArray(latest)) return;
      const remaining = latest.filter((entry) => {
        const cid = isRecord(entry) && isRecord(entry.delegation) ? entry.delegation.cid : undefined;
        return typeof cid !== "string" || (cid !== refusal.revokedCid && cid !== ancestorCid);
      });
      if (remaining.length === latest.length) return;
      this.#activeSessions.delete(tenant.stateRoot);
      const epoch = (this.#approvalEpochs.get(tenant.stateRoot) ?? tenant.approvalEpoch) + 1;
      this.#approvalEpochs.set(tenant.stateRoot, epoch);
      const profilePath = this.#profilePath(tenant.stateRoot);
      const profile = await readJson<Record<string, unknown>>(profilePath);
      await secureWrite(profilePath, { ...profile, approvalEpoch: epoch });
      if (remaining.length === 0) await rm(this.#additionalPath(tenant.stateRoot), { force: true });
      else await secureWrite(this.#additionalPath(tenant.stateRoot), remaining);
      const cleared = removed ?? new Set<string>();
      cleared.add(refusal.revokedCid);
      this.#clearedScoped.set(tenant.stateRoot, cleared);
    })().finally(() => this.#scopedClearing.delete(key));
    this.#scopedClearing.set(key, clearing);
    await clearing;
    return "scoped";
  }

  /**
   * The OpenKey link behind one of this server's `/connect?state=` links. The
   * first visit creates the OpenKey approval request, signed by the tenant's
   * own key; later visits reuse it. Collection starts in the background and on
   * the tenant's next call.
   */
  async approvalLink(state: string): Promise<string> {
    const located = await this.#readPending(state);
    const path = this.#pendingPath(located.stateRoot, located.pending.nonce);
    const prior = this.#linkCreations.get(path);
    if (prior) return prior;
    const creating = this.#createApprovalLink(located.stateRoot, located.pending)
      .finally(() => this.#linkCreations.delete(path));
    this.#linkCreations.set(path, creating);
    return creating;
  }

  async #createApprovalLink(stateRoot: string, initial: PendingApproval): Promise<string> {
    const path = this.#pendingPath(stateRoot, initial.nonce);
    // Reread under the per-link lock: an earlier visit may have created the request.
    const pending = await readJson<PendingApproval>(path);
    if (pending === null || pending.version !== PENDING_VERSION) {
      throw new ApprovalRequestError("state_not_pending", "Approval state is invalid or already used.");
    }
    if (pending.openkey !== undefined && this.#currentRequest(pending.openkey)) {
      if (Date.parse(pending.openkey.expiresAt) <= Date.now()) {
        throw new ApprovalRequestError("state_expired", "Approval state has expired.");
      }
      this.#startCollectionPoll(stateRoot, pending.nonce);
      return pending.openkey.link;
    }
    // A request made against other OpenKey origins is never opened or collected; this visit asks again.
    if (pending.openkey !== undefined) writeDiagnostic("approval dropped: reason=openkey_origin_changed");
    const tenant = await this.#readTenant(pending.tenantId);
    let openkey: OpenKeyRequestState;
    try {
      openkey = await createOpenKeyRequest(this.#endpoints, {
        jwk: tenant.jwk,
        nodeHost: this.#config.nodeHost,
        permissions: pending.permissions,
        reason: approvalReason(pending),
        grantLifetimeSeconds: this.#grantLifetimeSeconds,
        leaseLifetimeSeconds: BOOTSTRAP_LEASE_SECONDS,
        expiresAt: new Date(pending.expiresAt),
      });
    } catch (error) {
      throw new ApprovalLinkUnavailableError(error);
    }
    if (!samePrincipal(openkey.request.issuer, tenant.sessionDid)) {
      throw new ApprovalLinkUnavailableError(new Error("The approval request does not name this tenant's key."));
    }
    // The link stays usable as long as the OpenKey request it opens.
    const expiresAt = new Date(Math.max(Date.parse(pending.expiresAt), Date.parse(openkey.expiresAt))).toISOString();
    await secureWrite(path, { ...pending, expiresAt, openkey });
    this.#startCollectionPoll(stateRoot, pending.nonce);
    return openkey.link;
  }

  /**
   * Collect every approval result this tenant has open in OpenKey before a
   * call decides whether it is connected. The call waits at most
   * `CALL_COLLECTION_BUDGET_MS` in total; whatever is still running then
   * finishes in the background, and a failure leaves the pending approval for
   * the next call or poll.
   */
  async #collectApprovals(tenant: TenantProfile): Promise<void> {
    const budget = new AbortController();
    await Promise.race([
      this.#collectEach(tenant),
      sleep(CALL_COLLECTION_BUDGET_MS, undefined, { signal: budget.signal, ref: false }).catch(() => undefined),
    ]).finally(() => budget.abort());
  }

  async #collectEach(tenant: TenantProfile): Promise<void> {
    const directory = this.#pendingDirectory(tenant.stateRoot);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (name.endsWith(".json.processing")) await this.#recoverProcessing(join(directory, name));
    }
    const nonces = (await readdir(directory).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
    for (const nonce of nonces) {
      await this.#collectApproval(tenant.stateRoot, nonce, CALL_COLLECTION_TIMEOUT_MS);
    }
  }

  /**
   * A claimed result whose processing never finished (the server stopped
   * mid-way). Once it is stored only the acknowledgement remains; otherwise,
   * after a grace period, it becomes collectable again.
   */
  async #recoverProcessing(claimed: string): Promise<void> {
    const pending = await readJson<PendingApproval>(claimed).catch(() => null);
    if (pending === null || pending.version !== PENDING_VERSION || pending.openkey === undefined) {
      await rm(claimed, { force: true });
      return;
    }
    const stateRoot = join(this.#config.stateDir, "tenants", pending.tenantId);
    if (this.#collections.has(this.#pendingPath(stateRoot, pending.nonce))) return;
    if (pending.openkey.storedCid !== undefined) {
      await this.#acknowledge(stateRoot, pending.openkey);
      await rm(claimed, { force: true });
      return;
    }
    // The claim records its own time: a rename keeps the pending file's older mtime.
    const claimedAt = pending.claimedAt === undefined ? Number.NaN : Date.parse(pending.claimedAt);
    if (Date.now() - claimedAt < PROCESSING_STALE_MS) return;
    const { claimedAt: _claimed, ...fresh } = pending;
    await secureWrite(claimed.slice(0, -".processing".length), fresh);
    await rm(claimed, { force: true });
  }

  /** One collection attempt for one pending approval, single-flight per approval. */
  async #collectApproval(stateRoot: string, nonce: string, timeoutMs: number): Promise<CollectionOutcome> {
    const path = this.#pendingPath(stateRoot, nonce);
    const running = this.#collections.get(path);
    if (running) return running;
    const collecting = this.#collectStep(stateRoot, nonce, timeoutMs)
      .catch((error: unknown) => {
        writeDiagnostic(`approval collection failed: code=${collectionErrorCode(error)}`);
        return "retry" as const;
      })
      .finally(() => this.#collections.delete(path));
    this.#collections.set(path, collecting);
    return collecting;
  }

  async #collectStep(stateRoot: string, nonce: string, timeoutMs: number): Promise<CollectionOutcome> {
    const path = this.#pendingPath(stateRoot, nonce);
    const pending = await readJson<PendingApproval>(path).catch(() => null);
    if (pending === null || pending.version !== PENDING_VERSION || pending.openkey === undefined) return "idle";
    const openkey = pending.openkey;
    // Results are fetched only from the OpenKey API origin this server is configured with.
    if (!this.#currentRequest(openkey)) {
      writeDiagnostic("approval dropped: reason=openkey_origin_changed");
      await rm(path, { force: true });
      return "done";
    }
    if (Date.now() >= collectionDeadline(openkey)) {
      await rm(path, { force: true });
      return "done";
    }
    const tenant = await this.#readTenant(pending.tenantId);
    if ((pending.approvalEpoch ?? 0) !== tenant.approvalEpoch) {
      await rm(path, { force: true });
      return "done";
    }
    let collected: OpenKeyCollection;
    try {
      collected = await collectOpenKeyResult(openkey, tenant.jwk, timeoutMs);
    } catch (error) {
      if (!isApprovalClientError(error)) throw error;
      return this.#collectionRefused(path, pending, error);
    }
    if (collected.status === "pending") return "pending";
    if (collected.status === "discovered") {
      await secureWrite(path, {
        ...pending,
        openkey: { ...openkey, resultRef: collected.resultRef, resultExpiresAt: collected.resultExpiresAt },
      });
      return this.#collectStep(stateRoot, nonce, timeoutMs);
    }
    const claimed = `${path}.processing`;
    try {
      await rename(path, claimed);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return "done";
      throw error;
    }
    await secureWrite(claimed, { ...pending, claimedAt: new Date().toISOString() });
    const prior = this.#approvalProcessing.get(stateRoot);
    const processing = (async () => {
      if (prior) await prior.catch(() => undefined);
      const current = await this.#readTenant(pending.tenantId);
      if ((pending.approvalEpoch ?? 0) !== current.approvalEpoch) {
        throw new ApprovalRequestError("state_not_pending", "Approval state is invalid or already used.");
      }
      const { checked } = collected;
      const storedCid = pending.kind === "bootstrap"
        ? await this.#storeBootstrap(current, pending, checked.delegation, checked.ownerDid, checked.renewal)
        : await this.#storeDelegation(current, pending, checked.delegation, checked.ownerDid, checked.renewal);
      await secureWrite(claimed, { ...pending, openkey: { ...openkey, storedCid } });
    })();
    this.#approvalProcessing.set(stateRoot, processing);
    try {
      await processing;
    } catch (error) {
      if (error instanceof RenewalAdmissionUnavailableError) {
        // Nothing was stored: the same result is fetched and admitted again on the next collection.
        await secureWrite(path, pending).catch(() => undefined);
        await rm(claimed, { force: true });
        writeDiagnostic("approval renewal admission deferred: code=NODE_UNAVAILABLE");
        return "retry";
      }
      // The link stays usable: its next visit asks OpenKey again.
      const { openkey: _spent, ...fresh } = pending;
      await secureWrite(path, fresh).catch(() => undefined);
      await rm(claimed, { force: true });
      writeDiagnostic(approvalRefusalDiagnostic(error));
      return "done";
    } finally {
      if (this.#approvalProcessing.get(stateRoot) === processing) this.#approvalProcessing.delete(stateRoot);
    }
    await this.#acknowledge(stateRoot, openkey);
    await rm(claimed, { force: true });
    return "done";
  }

  async #collectionRefused(
    path: string,
    pending: PendingApproval,
    error: ApprovalClientError,
  ): Promise<CollectionOutcome> {
    switch (error.code) {
      case "network":
      case "unavailable":
        return "retry";
      case "request_expired":
        if (pending.openkey !== undefined && Date.now() < Date.parse(pending.openkey.expiresAt)) return "retry";
        await rm(path, { force: true });
        return "done";
      case "acknowledged":
        await rm(path, { force: true });
        return "done";
      default: {
        // The result is gone, refused by OpenKey, or does not answer this request.
        const { openkey: _spent, ...fresh } = pending;
        await secureWrite(path, fresh);
        writeDiagnostic(`approval result rejected: stage=collect code=${error.code.toUpperCase()}`);
        return "done";
      }
    }
  }

  async #acknowledge(stateRoot: string, openkey: OpenKeyRequestState): Promise<void> {
    try {
      const tenant = await this.#readTenant(basename(stateRoot));
      await ackOpenKeyResult(openkey, tenant.jwk, POLL_COLLECTION_TIMEOUT_MS);
    } catch (error) {
      // OpenKey drops an unacknowledged result when its retention ends.
      writeDiagnostic(`approval acknowledgement failed: code=${collectionErrorCode(error)}`);
    }
  }

  /**
   * Poll one opened approval until it is collected or its request and result
   * window end: every 2 s for the first minute, then every 10 s. At most
   * `MAX_COLLECTION_POLLS` run at once; beyond that the tenant's next call
   * collects.
   */
  #startCollectionPoll(stateRoot: string, nonce: string): void {
    const key = this.#pendingPath(stateRoot, nonce);
    if (this.#closed || this.#polls.has(key) || this.#polls.size >= MAX_COLLECTION_POLLS) return;
    const startedAt = Date.now();
    const schedule = (): void => {
      const delay = Date.now() - startedAt < FAST_POLL_WINDOW_MS ? APPROVAL_POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
      const timer = setTimeout(() => void tick(), delay);
      timer.unref();
      this.#polls.set(key, timer);
    };
    const tick = async (): Promise<void> => {
      const outcome = await this.#collectApproval(stateRoot, nonce, POLL_COLLECTION_TIMEOUT_MS);
      if (this.#closed || outcome === "done" || outcome === "idle") {
        this.#polls.delete(key);
        return;
      }
      schedule();
    };
    schedule();
  }

  /** Stop background collection and idle sweeps. Pending approvals stay on disk for the next start. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#sweepTimer);
    for (const timer of this.#polls.values()) clearTimeout(timer);
    this.#polls.clear();
    await Promise.allSettled([...this.#collections.values(), this.#sweeping]);
  }

  /**
   * Remove every tenant with no authenticated call for `TENANT_IDLE_MS`: its key, session, grants
   * and pending approvals. A call arriving during a removal waits for it, then starts with a new key.
   * Resolves to the number of tenants removed.
   */
  async sweepIdleTenants(): Promise<number> {
    this.#sweeping ??= this.#sweepIdle().finally(() => {
      this.#sweeping = undefined;
    });
    return this.#sweeping;
  }

  async #sweepIdle(): Promise<number> {
    const tenants = join(this.#config.stateDir, "tenants");
    const names = await readdir(tenants).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") return [];
      throw error;
    });
    let removed = 0;
    for (const tenantId of names) {
      if (this.#closed) break;
      if (!/^[a-f0-9]{64}$/.test(tenantId)) continue;
      const stateRoot = join(tenants, tenantId);
      const lastActivity = await this.#lastActivity(stateRoot);
      // Read again with no await before the removal is registered: a call seen meanwhile keeps the tenant.
      if (lastActivity === undefined ||
        Date.now() - Math.max(lastActivity, this.#lastCalls.get(stateRoot) ?? 0) < TENANT_IDLE_MS) continue;
      const removal = this.#removeTenant(tenantId, stateRoot).finally(() => this.#idleRemovals.delete(stateRoot));
      this.#idleRemovals.set(stateRoot, removal);
      await removal;
      removed++;
      writeDiagnostic("idle tenant removed");
    }
    return removed;
  }

  /** The latest call, call-marker, session or key time; undefined for a tenant with no key or session. */
  async #lastActivity(stateRoot: string): Promise<number | undefined> {
    const [marker, session, key] = await Promise.all(
      [this.#callMarkerPath(stateRoot), this.#sessionPath(stateRoot), this.#keyPath(stateRoot)]
        .map((path) => stat(path).then((entry) => entry.mtimeMs, () => undefined)),
    );
    if (session === undefined && key === undefined) return undefined;
    return Math.max(this.#lastCalls.get(stateRoot) ?? 0, marker ?? 0, session ?? 0, key ?? 0);
  }

  /** Clear the tenant's authority as a node refusal does, then remove its state, key included. */
  async #removeTenant(tenantId: string, stateRoot: string): Promise<void> {
    const tenant = await this.#readTenant(tenantId).catch(() => undefined);
    if (tenant !== undefined) await this.#clearAuthority(tenant);
    await rm(stateRoot, { recursive: true, force: true });
    this.#lastCalls.delete(stateRoot);
    this.#callMarks.delete(stateRoot);
  }

  /** Whether a stored request opens on, and is collected from, the OpenKey origins this server is configured with. */
  #currentRequest(openkey: OpenKeyRequestState): boolean {
    return openkey.apiOrigin === this.#endpoints.openkeyApiOrigin &&
      URL.canParse(openkey.link) && URL.canParse(this.#endpoints.openkeyOrigin) &&
      new URL(openkey.link).origin === new URL(this.#endpoints.openkeyOrigin).origin;
  }

  async #storeBootstrap(
    tenant: TenantProfile,
    pending: PendingApproval,
    data: Record<string, unknown>,
    resultOwner: string,
    renewal: ApprovalRenewal | undefined,
  ): Promise<string> {
    const { node, session } = await this.#restoreApproval(tenant, data, resultOwner);
    this.#assertCurrentApproval(pending, session);
    if (pending.ownerDids.length > 0 && !pending.ownerDids.some((did) => samePrincipal(node.did, did))) {
      throw new ApprovalOwnerMismatchError();
    }
    // The verifier reports one entry per signed action; the SDK subset check
    // judges each requested entry against every matching grant together.
    if (!isCapabilitySubset(pending.permissions, node.getVerifiedSessionCapabilities()).subset) {
      throw new Error("The approved delegation does not cover the requested account access.");
    }
    if (renewal !== undefined) await this.#admitRenewal(tenant, node.did, session, renewal);
    const profile = await readJson<Record<string, unknown>>(this.#profilePath(tenant.stateRoot));
    await secureWrite(this.#profilePath(tenant.stateRoot), {
      ...profile,
      ownerDid: normalizeDid(node.did),
      spaceId: session.spaceId,
    });
    // The lease is kept with the session it renews; restores past the signed end go through the node.
    await secureWrite(this.#sessionPath(tenant.stateRoot), {
      authMethod: "openkey",
      ...session,
      ...(renewal === undefined ? {} : { renewal }),
    });
    this.#renewalRequired.delete(tenant.stateRoot);
    this.#activeSessions.delete(tenant.stateRoot);
    return session.delegationCid;
  }

  /**
   * Check the owner's renewal lease against the grant it renews, then admit it at the node, before the
   * session is stored. Admission replays the exact signed lease, so a retry admits the same one.
   */
  async #admitRenewal(
    tenant: TenantProfile,
    ownerDid: string,
    session: CallbackSession,
    renewal: ApprovalRenewal,
  ): Promise<void> {
    let signed: { originalExpiresAt: string; leaseSignedExpiresAt: string };
    try {
      signed = await verifyOwnerRenewalLease(session, ownerDid, renewal);
    } catch (error) {
      throw new ApprovalStageError("renewal", "RENEWAL_LEASE_MISMATCH", undefined, error);
    }
    // The node renews only a grant that outlives a few of its renewal rounds.
    if (Date.parse(signed.originalExpiresAt) - Date.now() < RENEWAL_ADMISSION_LEAD_MS) {
      throw new ApprovalStageError("renewal", "RENEWAL_GRANT_ENDS_TOO_SOON");
    }
    try {
      await admitOwnerRenewalLease({
        host: new URL(this.#config.nodeHost).origin,
        originalAuthorization: session.delegationHeader.Authorization,
        originalCid: session.delegationCid,
        ownerDid,
        agentDid: tenant.sessionDid.split("#")[0]!,
        spaceId: session.spaceId,
        nodeIdentity: renewal.receipt.nodeIdentity,
        leaseAuthorization: renewal.receipt.leaseAuthorization,
        leaseCid: renewal.receipt.leaseCid,
        leaseExpiresAt: signed.leaseSignedExpiresAt,
      });
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      // A changed renewer never renews this lease, and an ended grant cannot start one: ask again.
      if (code === RENEWAL_RENEWER_CHANGED || code === RENEWAL_LEASE_ORIGINAL_EXPIRED) {
        throw new ApprovalStageError("renewal", code, undefined, error);
      }
      throw new RenewalAdmissionUnavailableError(error);
    }
  }

  async #storeDelegation(
    tenant: TenantProfile,
    pending: PendingApproval,
    data: Record<string, unknown>,
    resultOwner: string,
    renewal: ApprovalRenewal | undefined,
  ): Promise<string> {
    if (pending.requestId === undefined) throw new Error("Authority request is missing.");
    // Unlike bootstrap there is no empty-list exemption: a delegation is only
    // imported when its verified signer is the OAuth principal that asked.
    const { node, session } = await this.#restoreApproval(tenant, data, resultOwner);
    this.#assertCurrentApproval(pending, session);
    if (!pending.ownerDids.some((did) => samePrincipal(node.did, did))) throw new ApprovalOwnerMismatchError();
    // OpenKey returns a signed-login (CACAO) delegation. Every field is
    // projected from the verified SIWE; `tinycloud.auth.import` verifies it
    // again and checks it stays within the stored request.
    let delegation: PortableDelegation;
    try {
      delegation = siweRuntimeDelegation(node, {
        authorization: session.delegationHeader.Authorization,
        cid: session.delegationCid,
        spaceId: session.spaceId,
        ownerAddress: session.address,
        chainId: session.chainId,
        siwe: session.siwe,
        signature: session.signature,
        host: this.#config.nodeHost,
      });
    } catch (error) {
      throw new ApprovalStageError(
        "siwe_runtime_delegation",
        "DELEGATION_REJECTED",
        error instanceof RuntimeDelegationRejectedError ? error.reason : undefined,
        error,
      );
    }
    if (renewal !== undefined) await this.#admitRenewal(tenant, node.did, session, renewal);
    // The lease is stored with the grant it renews; replay past the signed end goes through the node.
    const result = await invokeOperation(
      "tinycloud.auth.import",
      1,
      { profile: PROFILE, stateRoot: tenant.stateRoot },
      {
        kind: "tinycloud.auth.delegation",
        version: 1,
        requestId: pending.requestId,
        delegationCid: delegation.cid,
        delegation,
        ...(renewal === undefined ? {} : { renewal }),
      },
    );
    if (result.status === "error") {
      const reason = result.error.details?.reason;
      // Only a refused node activation carries a rejection reason on DELEGATION_REJECTED.
      throw new ApprovalStageError(
        result.error.code === "DELEGATION_REJECTED" && typeof reason === "string" ? "activation" : "auth_import",
        result.error.code,
        typeof reason === "string" ? reason : undefined,
      );
    }
    if (result.status !== "ok") throw new ApprovalStageError("auth_import", "AUTHORITY_REQUIRED");
    return session.delegationCid;
  }

  #assertCurrentApproval(pending: PendingApproval, session: CallbackSession): void {
    const issuedAt = /^Issued At: ([^\r\n]+)\r?$/m.exec(session.siwe)?.[1];
    if (issuedAt === undefined || !Number.isFinite(Date.parse(issuedAt)) ||
      Date.parse(issuedAt) < Date.parse(pending.createdAt)) {
      throw new ApprovalStageError("restore_approval", "APPROVAL_PREDATES_REQUEST");
    }
  }

  /**
   * Verify OpenKey's delegation as a SIWE session for this tenant's key. It
   * must carry the full signed proof (SIWE, signature, address and chain), so
   * the WASM verifier always runs: it binds the authorization bytes and CID to
   * the signed SIWE, and `node.did` is the wallet that signed exactly the
   * delegation being stored. That wallet must be the owner OpenKey's result
   * names.
   */
  async #restoreApproval(
    tenant: TenantProfile,
    data: Record<string, unknown>,
    resultOwner: string,
  ): Promise<{ node: TinyCloudNode; session: CallbackSession }> {
    let session: CallbackSession;
    try {
      session = sessionFromCallback(data, tenant.jwk);
    } catch (error) {
      throw new ApprovalStageError("restore_approval", "CALLBACK_INCOMPLETE", undefined, error);
    }
    const node = new TinyCloudNode({ host: this.#config.nodeHost });
    try {
      await node.restoreSession(session);
    } catch (error) {
      throw new ApprovalStageError(
        "restore_approval",
        error instanceof InvalidRestoredSessionError || error instanceof UnsupportedSessionRestoreError
          ? error.code
          : "SESSION_RESTORE_FAILED",
        undefined,
        error,
      );
    }
    if (!samePrincipal(node.sessionDid, tenant.sessionDid)) {
      throw new ApprovalStageError("restore_approval", "SESSION_MISMATCH");
    }
    if (!samePrincipal(node.did, resultOwner)) {
      throw new ApprovalStageError("restore_approval", "RESULT_OWNER_MISMATCH");
    }
    return { node, session };
  }

  async #ensureTenant(subject: string): Promise<TenantProfile> {
    const tenantId = this.#tenantId(subject);
    const stateRoot = join(this.#config.stateDir, "tenants", tenantId);
    const calledAt = Date.now();
    this.#lastCalls.set(stateRoot, calledAt);
    await this.#idleRemovals.get(stateRoot);
    let initializing = this.#initializing.get(tenantId);
    if (initializing === undefined) {
      initializing = this.#initializeTenant(tenantId).finally(() => {
        this.#initializing.delete(tenantId);
      });
      this.#initializing.set(tenantId, initializing);
    }
    const tenant = await initializing;
    if (calledAt - (this.#callMarks.get(stateRoot) ?? 0) >= CALL_MARK_INTERVAL_MS) {
      this.#callMarks.set(stateRoot, calledAt);
      await writeFile(this.#callMarkerPath(stateRoot), "", { mode: 0o600 });
    }
    return tenant;
  }

  async #hasValidSession(
    tenant: TenantProfile,
    ownerDids: readonly string[],
    fresh = false,
  ): Promise<boolean> {
    return (await this.#sessionState(tenant, ownerDids, fresh)) !== "invalid";
  }

  async #sessionState(
    tenant: TenantProfile,
    ownerDids: readonly string[],
    fresh = false,
  ): Promise<SessionState> {
    if (this.#renewalRequired.has(tenant.stateRoot)) return "invalid";
    const key = JSON.stringify([tenant.stateRoot, ownerDids.map(normalizeDid), fresh]);
    const current = this.#sessionChecks.get(key);
    if (current) return current;
    const checking = this.#checkSession(tenant, ownerDids, fresh).finally(() => {
      this.#sessionChecks.delete(key);
    });
    this.#sessionChecks.set(key, checking);
    return checking;
  }

  async #checkSession(
    tenant: TenantProfile,
    ownerDids: readonly string[],
    fresh: boolean,
  ): Promise<SessionState> {
    let raw: Record<string, unknown> | null;
    try {
      raw = await readJson<Record<string, unknown>>(this.#sessionPath(tenant.stateRoot));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await this.#clearAuthority(tenant);
      return "invalid";
    }
    if (raw === null) return "invalid";
    const node = new TinyCloudNode({ host: this.#config.nodeHost });
    try {
      // Past its signed end, a session stored with a renewal lease restores only through the node.
      await restoreStoredSession(node, raw as unknown as TinyCloudSession, raw);
    } catch (error) {
      const header = isRecord(raw.delegationHeader) ? raw.delegationHeader.Authorization : undefined;
      const signedExpiry = typeof header === "string" ? signedCompactUcanExpiry(header) : undefined;
      const siweExpiry = typeof raw.siwe === "string"
        ? /^Expiration Time: ([^\r\n]+)\r?$/m.exec(raw.siwe)?.[1]
        : undefined;
      const expiry = signedExpiry ?? (siweExpiry === undefined ? undefined : new Date(siweExpiry));
      if (expiry !== undefined && expiry.getTime() <= Date.now()) {
        // An ended, stopped or re-issued lease asks again; a node that did not answer confirms nothing.
        const ended = isRecord(error) && error.code === "AUTH_EXPIRED";
        return liveStoredLease(raw) !== undefined && !ended ? "unknown" : "invalid";
      }
      await this.#clearAuthority(tenant);
      return "invalid";
    }
    if (!samePrincipal(node.sessionDid, tenant.sessionDid) ||
      !ownerDids.some((did) => samePrincipal(node.did, did))) return "invalid";
    const additional = await readJson<unknown>(this.#additionalPath(tenant.stateRoot));
    const cids = [raw.delegationCid];
    if (additional !== null) {
      if (!Array.isArray(additional)) throw new Error("Stored TinyCloud authority is unavailable.");
      for (const entry of additional) {
        const cid = isRecord(entry) && isRecord(entry.delegation) ? entry.delegation.cid : undefined;
        cids.push(cid);
      }
    }
    if (!cids.every((cid): cid is string => typeof cid === "string" && cid.length > 0)) {
      throw new Error("Stored TinyCloud authority is unavailable.");
    }
    const fingerprint = cids.join("\n");
    const cached = this.#activeSessions.get(tenant.stateRoot);
    if (!fresh && cached?.cids === fingerprint && cached.until > Date.now()) return "valid";
    // A node refusal is actionable only when it names this stored permission.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2_000);
      timer.unref();
    });
    const probe = await Promise.race([
      node.kvForSpace(String(raw.spaceId)).list({ prefix: "spaces/" }).catch(() => undefined),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const refusal = probe !== undefined && !probe.ok ? nodeRevocationOf(probe.error) : undefined;
    if (refusal !== undefined &&
      (refusal.revokedCid === raw.delegationCid ||
        (refusal.reason === "delegation_ancestor_revoked" && refusal.ancestorCid === raw.delegationCid))) {
      await this.#clearAuthority(tenant);
      return "invalid";
    }
    if (this.#renewalRequired.has(tenant.stateRoot)) return "invalid";
    if (probe?.ok) {
      this.#activeSessions.set(tenant.stateRoot, { cids: fingerprint, until: Date.now() + 30_000 });
      return "valid";
    }
    // Timeouts, transport errors and refusals that do not name this permission
    // leave the stored session in place without confirming it.
    return "unknown";
  }

  async #clearAuthority(tenant: TenantProfile): Promise<void> {
    const current = this.#clearing.get(tenant.stateRoot);
    if (current) return current;
    this.#activeSessions.delete(tenant.stateRoot);
    this.#renewalRequired.add(tenant.stateRoot);
    this.#clearedScoped.delete(tenant.stateRoot);
    this.#approvalEpochs.set(
      tenant.stateRoot,
      (this.#approvalEpochs.get(tenant.stateRoot) ?? tenant.approvalEpoch) + 1,
    );
    const clearing = (async () => {
      const processing = this.#approvalProcessing.get(tenant.stateRoot);
      if (processing) await processing.catch(() => undefined);
      const scoped = this.#scopedClearing.get(tenant.stateRoot);
      if (scoped) await scoped;
      this.#renewalRequired.add(tenant.stateRoot);
      const profilePath = this.#profilePath(tenant.stateRoot);
      const profile = await readJson<Record<string, unknown>>(profilePath);
      await secureWrite(profilePath, {
        ...profile,
        approvalEpoch: this.#approvalEpochs.get(tenant.stateRoot),
      });
      await rm(this.#additionalPath(tenant.stateRoot), { force: true });
      await rm(join(tenant.stateRoot, ".tinycloud", "profiles", PROFILE, "auth-requests.json"), { force: true });
      await rm(this.#pendingDirectory(tenant.stateRoot), { recursive: true, force: true });
      await rm(this.#sessionPath(tenant.stateRoot), { force: true });
    })().finally(() => this.#clearing.delete(tenant.stateRoot));
    this.#clearing.set(tenant.stateRoot, clearing);
    await clearing;
  }

  async #initializeTenant(tenantId: string): Promise<TenantProfile> {
    const stateRoot = join(this.#config.stateDir, "tenants", tenantId);
    const keyPath = this.#keyPath(stateRoot);
    await secureDirectory(join(stateRoot, ".tinycloud", "profiles", PROFILE));
    let jwk = await readJson<Record<string, unknown>>(keyPath);
    let sessionDid: string;
    if (jwk === null) {
      const generated = generateSessionKey();
      jwk = generated.jwk;
      sessionDid = generated.did;
      await secureWrite(keyPath, jwk);
    } else {
      sessionDid = didFromJwk(jwk);
    }
    const profilePath = this.#profilePath(stateRoot);
    const profile = await readJson<Record<string, unknown>>(profilePath);
    if (profile === null) {
      await secureWrite(profilePath, {
        name: PROFILE,
        host: this.#config.nodeHost,
        chainId: 1,
        spaceName: "default",
        did: sessionDid,
        sessionDid,
        createdAt: new Date().toISOString(),
        posture: "delegate-session",
        operatorType: "agent",
        authMethod: "openkey",
        openkeyHost: this.#config.openkeyHost,
      });
    } else if (
      typeof profile.host === "string" &&
      PRODUCTION_NODE_HOSTS.has(profile.host.replace(/\/+$/, "")) &&
      PRODUCTION_NODE_HOSTS.has(this.#config.nodeHost.replace(/\/+$/, "")) &&
      profile.host.replace(/\/+$/, "") !== this.#config.nodeHost.replace(/\/+$/, "")
    ) {
      // The runtime already talks to TC_HOST, but `tinycloud.auth.import`
      // checks the stored host, so a tenant left on another production name
      // refuses every authority approval. Any other stored host is a
      // deliberate pin and keeps its DELEGATION_HOST_MISMATCH.
      await secureWrite(profilePath, { ...profile, host: this.#config.nodeHost });
      process.stderr.write(
        `[tinycloud-mcp-http] tenant node host migrated: from=${profile.host.replace(/\/+$/, "")} to=${new URL(this.#config.nodeHost).origin}\n`,
      );
    }
    const approvalEpoch = this.#approvalEpochs.get(stateRoot) ??
      (typeof profile?.approvalEpoch === "number" ? profile.approvalEpoch : 0);
    this.#approvalEpochs.set(stateRoot, approvalEpoch);
    return { stateRoot, sessionDid, jwk, approvalEpoch };
  }

  async #readTenant(tenantId: string): Promise<TenantProfile> {
    if (!/^[a-f0-9]{64}$/.test(tenantId)) throw new ApprovalRequestError("state_invalid", "Approval state is invalid.");
    const stateRoot = join(this.#config.stateDir, "tenants", tenantId);
    const jwk = await readJson<Record<string, unknown>>(this.#keyPath(stateRoot));
    if (jwk === null) throw new ApprovalRequestError("tenant_missing", "The TinyCloud delegate no longer exists.");
    const profile = await readJson<Record<string, unknown>>(this.#profilePath(stateRoot));
    const approvalEpoch = this.#approvalEpochs.get(stateRoot) ??
      (typeof profile?.approvalEpoch === "number" ? profile.approvalEpoch : 0);
    return { stateRoot, jwk, sessionDid: didFromJwk(jwk), approvalEpoch };
  }

  async #createPending(
    subject: string,
    ownerDids: readonly string[],
    kind: PendingApproval["kind"],
    permissions: PermissionEntry[],
    requestId?: string,
  ): Promise<PendingApproval> {
    const clearing = this.#clearing.get(this.tenantStateRoot(subject));
    if (clearing) await clearing;
    const tenant = await this.#ensureTenant(subject);
    const tenantId = this.#tenantId(subject);
    const normalizedOwners = ownerDids.map(normalizeDid);
    const key = JSON.stringify([tenantId, tenant.approvalEpoch, kind, requestId, permissions, normalizedOwners]);
    const current = this.#pendingWrites.get(key);
    if (current) return current;
    const writing = this.#writePending(tenant, tenantId, kind, permissions, normalizedOwners, requestId)
      .finally(() => this.#pendingWrites.delete(key));
    this.#pendingWrites.set(key, writing);
    return writing;
  }

  async #writePending(
    tenant: TenantProfile,
    tenantId: string,
    kind: PendingApproval["kind"],
    permissions: PermissionEntry[],
    ownerDids: string[],
    requestId?: string,
  ): Promise<PendingApproval> {
    const reusable = await reusablePending(
      this.#pendingDirectory(tenant.stateRoot),
      { tenantId, approvalEpoch: tenant.approvalEpoch, kind, requestId, permissions, ownerDids },
      (openkey) => this.#currentRequest(openkey) && openkey.request.renewal?.leaseLifetimeSeconds === BOOTSTRAP_LEASE_SECONDS,
    );
    if (reusable !== undefined) return reusable;
    const nonce = randomBytes(24).toString("base64url");
    const created = Date.now();
    const pending: PendingApproval = {
      version: PENDING_VERSION,
      nonce,
      tenantId,
      approvalEpoch: tenant.approvalEpoch,
      kind,
      ...(requestId === undefined ? {} : { requestId }),
      permissions,
      ownerDids,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.#config.approvalTtlSeconds * 1000).toISOString(),
    };
    await secureWrite(this.#pendingPath(tenant.stateRoot, nonce), pending);
    return pending;
  }

  async #readPending(state: string): Promise<{ stateRoot: string; pending: PendingApproval }> {
    const [tenantId, nonce, signature] = state.split(".");
    if (tenantId === undefined || nonce === undefined || signature === undefined) {
      throw new ApprovalRequestError("state_invalid", "Approval state is invalid.");
    }
    const expected = this.#signState(tenantId, nonce);
    const supplied = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) {
      throw new ApprovalRequestError("state_invalid", "Approval state is invalid.");
    }
    const stateRoot = join(this.#config.stateDir, "tenants", tenantId);
    const path = this.#pendingPath(stateRoot, nonce);
    const pending = await readJson<PendingApproval>(path);
    if (pending === null) {
      // The state is signed by this server, so a missing tenant key means the
      // tenant directory itself is gone (for example a reset state volume).
      const tenantExists = await readJson<unknown>(this.#keyPath(stateRoot)).then(
        (jwk) => jwk !== null,
        () => true,
      );
      if (!tenantExists) throw new ApprovalRequestError("tenant_missing", "The TinyCloud delegate no longer exists.");
      // Already used, being processed, or never issued. This is not proof of
      // replay: an expired link lands here too once its pending file is gone.
      throw new ApprovalRequestError("state_not_pending", "Approval state is invalid or already used.");
    }
    if (pending.version !== PENDING_VERSION || pending.tenantId !== tenantId || pending.nonce !== nonce) {
      throw new ApprovalRequestError("state_not_pending", "Approval state is invalid or already used.");
    }
    const profile = await readJson<Record<string, unknown>>(this.#profilePath(stateRoot));
    const approvalEpoch = this.#approvalEpochs.get(stateRoot) ??
      (typeof profile?.approvalEpoch === "number" ? profile.approvalEpoch : 0);
    if ((pending.approvalEpoch ?? 0) !== approvalEpoch) {
      throw new ApprovalRequestError("state_not_pending", "Approval state is invalid or already used.");
    }
    if (new Date(pending.expiresAt).getTime() <= Date.now()) {
      // A result approved just before the end may still be collected.
      if (pending.openkey === undefined || Date.now() >= collectionDeadline(pending.openkey)) {
        await rm(path, { force: true });
      }
      throw new ApprovalRequestError("state_expired", "Approval state has expired.");
    }
    return { stateRoot, pending };
  }

  #connectUrl(pending: PendingApproval): string {
    const url = new URL(this.#config.approvalPath ?? "/connect", this.#config.publicUrl);
    url.searchParams.set("state", `${pending.tenantId}.${pending.nonce}.${this.#signState(pending.tenantId, pending.nonce)}`);
    return url.toString();
  }

  async #withNativeGrantLock<T>(ownerDid: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#nativeGrantQueues.get(ownerDid) ?? Promise.resolve();
    let releaseNext!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    this.#nativeGrantQueues.set(ownerDid, next);
    await previous;
    try {
      return await action();
    } finally {
      releaseNext();
      if (this.#nativeGrantQueues.get(ownerDid) === next) this.#nativeGrantQueues.delete(ownerDid);
    }
  }
  async #loadNativeServiceKey(): Promise<{ did: string; jwk: Record<string, unknown> }> {
    if (this.#nativeIdentity === undefined) {
      const loading = this.#readOrCreateNativeServiceKey();
      this.#nativeIdentity = loading;
      void loading.catch(() => {
        if (this.#nativeIdentity === loading) this.#nativeIdentity = undefined;
      });
    }
    return this.#nativeIdentity;
  }

  async #readOrCreateNativeServiceKey(): Promise<{ did: string; jwk: Record<string, unknown> }> {
    const path = join(this.#config.stateDir, ".tinycloud", "native-service-key.json");
    await secureDirectory(dirname(path));
    let stored = await readJson<NativeServiceKey>(path);
    if (stored === null) {
      const generated = generateSessionKey();
      try {
        await writeFile(path, `${JSON.stringify({ version: 1, jwk: generated.jwk })}\n`, {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
      }
      await chmod(path, 0o600);
      stored = await readJson<NativeServiceKey>(path);
    }
    if (stored === null || !isRecord(stored) || stored.version !== 1 || !isRecord(stored.jwk)) {
      throw new Error("The native MCP service identity is unavailable.");
    }
    return { did: didFromJwk(stored.jwk), jwk: stored.jwk };
  }

  async #activateNativeDelegation(
    serialized: string,
    identity: { did: string; jwk: Record<string, unknown> },
  ): Promise<{
    ownerDid: string;
    spaceId: string;
    permissions: PermissionEntry[];
    cid: string;
    expiresAt: Date;
    delegation: PortableDelegation;
  }> {
    let delegation: PortableDelegation;
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (!isRecord(parsed)) throw new Error("invalid delegation");
      delegation = deserializeDelegation(serialized);
    } catch {
      throw new NativeGrantValidationError("native_grant_rejected");
    }
    if (!isRecord(delegation.delegationHeader) ||
      typeof delegation.delegationHeader.Authorization !== "string" ||
      delegation.delegationHeader.Authorization.length === 0 ||
      typeof delegation.cid !== "string" || delegation.cid.length === 0 ||
      typeof delegation.delegateDID !== "string" ||
      !samePrincipal(delegation.delegateDID, normalizeDid(identity.did)) ||
      typeof delegation.spaceId !== "string" ||
      typeof delegation.ownerAddress !== "string" ||
      !Number.isSafeInteger(delegation.chainId) ||
      typeof delegation.host !== "string" || !sameNodeHost(delegation.host, this.#config.nodeHost) ||
      !(delegation.expiry instanceof Date) || !Number.isFinite(delegation.expiry.getTime())) {
      throw new NativeGrantValidationError("native_grant_rejected");
    }
    const now = Date.now();
    const claimedExpiry = delegation.expiry.getTime();
    if (claimedExpiry <= now) throw new NativeGrantValidationError("native_grant_expired");
    if (claimedExpiry > now + NATIVE_GRANT_MAX_LIFETIME_SECONDS * 1_000) {
      throw new NativeGrantValidationError("native_grant_rejected");
    }

    let ownerDid: string | undefined;
    let spaceId: string | undefined;
    const node = new TinyCloudNode({ host: this.#config.nodeHost });
    try {
      await node.restoreSession({
        delegationHeader: delegation.delegationHeader,
        delegationCid: delegation.cid,
        spaceId: delegation.spaceId,
        jwk: identity.jwk,
        verificationMethod: identity.did,
        tinycloudHosts: [this.#config.nodeHost],
      });
      const activated = await activateValidatedRuntimeDelegation(node, delegation, {
        host: this.#config.nodeHost,
        authorize: (permissions) => {
          const derivedOwner = nativeOwnerForConnectorGrant(permissions);
          const signedSpace = permissions[0]?.space;
          if (derivedOwner === undefined || signedSpace === undefined) return false;
          const metadataOwner = canonicalOwnerDid(
            `did:pkh:eip155:${delegation.chainId}:${delegation.ownerAddress}`,
          );
          if (metadataOwner !== derivedOwner ||
            delegation.spaceId.toLowerCase() !== signedSpace.toLowerCase()) return false;
          ownerDid = derivedOwner;
          spaceId = signedSpace;
          return true;
        },
      });
      if (ownerDid === undefined || spaceId === undefined ||
        !samePrincipal(activated.audience, normalizeDid(identity.did)) ||
        activated.expiry.getTime() > now + NATIVE_GRANT_MAX_LIFETIME_SECONDS * 1_000) {
        throw new NativeGrantValidationError("native_grant_rejected");
      }
      return {
        ownerDid,
        spaceId,
        permissions: [...activated.effectivePermissions],
        cid: activated.cid,
        expiresAt: activated.expiry,
        delegation: activated.delegation,
      };
    } catch (error) {
      if (error instanceof NativeGrantValidationError) throw error;
      if (error instanceof RuntimeDelegationRejectedError) {
        throw new NativeGrantValidationError(
          error.reason === "expired"
            ? "native_grant_expired"
            : error.reason === "activation_unavailable"
              ? "native_grant_validation_unavailable"
              : "native_grant_rejected",
        );
      }
      throw new NativeGrantValidationError("native_grant_validation_unavailable");
    }
  }

  #nativeGrantPath(stateRoot: string): string {
    return join(stateRoot, ".tinycloud", "native-grant.json");
  }
  #tenantId(subject: string): string {
    return createHmac("sha256", this.#config.stateSecret).update(`tenant:${subject}`).digest("hex");
  }

  #signState(tenantId: string, nonce: string): string {
    return createHmac("sha256", this.#config.stateSecret)
      .update(`approval:${tenantId}:${nonce}`)
      .digest("base64url");
  }

  #profilePath(stateRoot: string): string {
    return join(stateRoot, ".tinycloud", "profiles", PROFILE, "profile.json");
  }

  #keyPath(stateRoot: string): string {
    return join(stateRoot, ".tinycloud", "profiles", PROFILE, "key.json");
  }

  #sessionPath(stateRoot: string): string {
    return join(stateRoot, ".tinycloud", "profiles", PROFILE, "session.json");
  }

  #additionalPath(stateRoot: string): string {
    return join(stateRoot, ".tinycloud", "profiles", PROFILE, "additional-delegations.json");
  }

  #pendingPath(stateRoot: string, nonce: string): string {
    return join(this.#pendingDirectory(stateRoot), `${nonce}.json`);
  }

  #pendingDirectory(stateRoot: string): string {
    return join(stateRoot, ".tinycloud", "profiles", PROFILE, "pending");
  }

  #callMarkerPath(stateRoot: string): string {
    return join(stateRoot, ".tinycloud", "last-call");
  }
}

let wasmInitialized = false;

function generateSessionKey(): { jwk: Record<string, unknown>; did: string } {
  ensureWasm();
  const manager = new TCWSessionManager();
  const keyId = manager.createSessionKey("hosted-mcp");
  const serialized = manager.jwk(keyId);
  if (!serialized) throw new Error("Could not generate the hosted delegate key.");
  return { jwk: JSON.parse(serialized) as Record<string, unknown>, did: manager.getDID(keyId) };
}

function didFromJwk(jwk: Record<string, unknown>): string {
  ensureWasm();
  const manager = new TCWSessionManager();
  const keyId = importKey(manager, JSON.stringify(jwk), "hosted-mcp");
  return manager.getDID(keyId);
}

function ensureWasm(): void {
  if (wasmInitialized) return;
  initPanicHook();
  wasmInitialized = true;
}

function revocationFromResult(error: Record<string, unknown>): NodeRevocation | undefined {
  const details = error.details;
  if (!isRecord(details) || typeof details.revokedCid !== "string") return undefined;
  if (details.reason === "delegation_revoked") {
    return { reason: "delegation_revoked", revokedCid: details.revokedCid };
  }
  if (details.reason === "delegation_ancestor_revoked" && typeof details.ancestorCid === "string") {
    return {
      reason: "delegation_ancestor_revoked",
      revokedCid: details.revokedCid,
      ancestorCid: details.ancestorCid,
    };
  }
  return undefined;
}

/**
 * Parse the OpenKey callback. Every signed-proof field is required: without
 * them `restoreSession` verifies nothing and `node.did` would fall back to the
 * tenant's own key.
 */
function sessionFromCallback(data: Record<string, unknown>, privateJwk: Record<string, unknown>): CallbackSession {
  const delegationHeader = data.delegationHeader;
  if (!isRecord(delegationHeader) || typeof delegationHeader.Authorization !== "string" ||
    typeof data.delegationCid !== "string" || typeof data.spaceId !== "string" ||
    typeof data.verificationMethod !== "string" || typeof data.address !== "string" ||
    typeof data.chainId !== "number" || typeof data.siwe !== "string" ||
    typeof data.signature !== "string") {
    throw new Error("OpenKey returned an incomplete delegation.");
  }
  return {
    delegationHeader: { Authorization: delegationHeader.Authorization },
    delegationCid: data.delegationCid,
    spaceId: data.spaceId,
    jwk: privateJwk,
    verificationMethod: data.verificationMethod,
    address: data.address,
    chainId: data.chainId,
    siwe: data.siwe,
    signature: data.signature,
  };
}

/** What the approver reads in OpenKey. */
function approvalReason(pending: PendingApproval): string {
  return [
    pending.kind === "bootstrap"
      ? "Connect this TinyCloud account to the hosted MCP delegate."
      : tcAppsApprovalReason(pending.permissions) ??
        "Approve the exact capabilities requested by the TinyCloud MCP operation.",
    // Owner DIDs come from the verified OpenKey access token of the MCP
    // client that created this link, never from the link itself. Collection
    // refuses a signer outside them, so the approver isn't asked to check.
    ...(pending.ownerDids.length === 0
      ? []
      : [`Requested by TinyCloud account ${pending.ownerDids.join(", ")}.`]),
  ].join(" ");
}

/**
 * The last moment a result for this request may still be collected: OpenKey keeps a result at most
 * `RESULT_COLLECTION_GRACE_MS` after it is approved, and approval ends with the request. A later
 * retention OpenKey reports never extends collection.
 */
function collectionDeadline(openkey: OpenKeyRequestState): number {
  return Date.parse(openkey.expiresAt) + RESULT_COLLECTION_GRACE_MS;
}

/** An identifier for a collection failure; never OpenKey, delegation or node text. */
function collectionErrorCode(error: unknown): string {
  if (isApprovalClientError(error)) return error.code.toUpperCase();
  if (error instanceof ApprovalRequestError) return error.detail.toUpperCase();
  return "UNKNOWN";
}

/**
 * The log line for a refused approval. Stage, code, reason and detail are
 * identifiers, never OpenKey, delegation or node text.
 */
export function approvalRefusalDiagnostic(error: unknown): string {
  if (error instanceof ApprovalOwnerMismatchError) {
    return "approval result rejected: stage=owner code=APPROVAL_OWNER_MISMATCH detail=none";
  }
  const stage = error instanceof ApprovalStageError ? error.stage : "unknown";
  const code = error instanceof ApprovalStageError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : "UNKNOWN";
  const reason = !(error instanceof ApprovalStageError) || error.reason === undefined
    ? undefined
    : RUNTIME_DELEGATION_REJECTIONS.find((known) => known === error.reason) ?? "unknown";
  const detail = error instanceof ApprovalRequestError ? error.detail : "none";
  return `approval result rejected: stage=${stage} code=${code}${reason === undefined ? "" : ` reason=${reason}`} detail=${detail}`;
}

function writeDiagnostic(message: string): void {
  process.stderr.write(`[tinycloud-mcp-http] ${message}\n`);
}

function samePrincipal(left: string | undefined, right: string): boolean {
  if (typeof left !== "string") return false;
  try {
    return principalDidEquals(left, right);
  } catch {
    return false;
  }
}

function normalizeDid(value: string): string {
  return value.split("#", 1)[0]!;
}

function sameNodeHost(left: string, right: string): boolean {
  if (PRODUCTION_NODE_HOSTS.has(left) && sameTinyCloudNode(left, right)) return true;
  try {
    const normalize = (value: string): string => {
      const url = new URL(value);
      if (url.username !== "" || url.password !== "") return "";
      url.hash = "";
      url.search = "";
      url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString().replace(/\/+$/, "");
    };
    return normalize(left) !== "" && normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

function isPermissionEntry(value: unknown): value is PermissionEntry {
  return isRecord(value) && typeof value.service === "string" && typeof value.space === "string" &&
    typeof value.path === "string" && Array.isArray(value.actions) &&
    value.actions.every((action) => typeof action === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function secureWrite(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await secureDirectory(directory);
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, jsonReplacer, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreOptionalText(path: string, contents: string | null): Promise<void> {
  if (contents === null) {
    await rm(path, { force: true });
    return;
  }
  await secureDirectory(dirname(path));
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * A live pending approval for exactly this request, if one exists. One whose OpenKey request
 * `currentRequest` refuses (other origins, another renewal ask) is never reused.
 */
async function reusablePending(
  directory: string,
  expected: Pick<PendingApproval, "tenantId" | "approvalEpoch" | "kind" | "requestId" | "permissions" | "ownerDids">,
  currentRequest: (openkey: OpenKeyRequestState) => boolean,
): Promise<PendingApproval | undefined> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const active: PendingApproval[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const pending = await readJson<PendingApproval>(path).catch(() => null);
    if (pending === null) {
      await rm(path, { force: true });
      continue;
    }
    if (new Date(pending.expiresAt).getTime() <= Date.now()) {
      // A result approved just before the end may still be collected.
      if (pending.openkey === undefined || Date.now() >= collectionDeadline(pending.openkey)) {
        await rm(path, { force: true });
      }
      continue;
    }
    active.push(pending);
    if (samePendingRequest(pending, expected) &&
      (pending.openkey === undefined || currentRequest(pending.openkey))) return pending;
  }
  if (active.length >= 64) {
    active.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    await rm(join(directory, `${active[0]!.nonce}.json`), { force: true });
  }
  return undefined;
}

function samePendingRequest(
  pending: PendingApproval,
  expected: Pick<PendingApproval, "tenantId" | "approvalEpoch" | "kind" | "requestId" | "permissions" | "ownerDids">,
): boolean {
  return pending.version === PENDING_VERSION && pending.tenantId === expected.tenantId &&
    (pending.approvalEpoch ?? 0) === expected.approvalEpoch &&
    pending.kind === expected.kind && pending.requestId === expected.requestId &&
    JSON.stringify(pending.permissions) === JSON.stringify(expected.permissions) &&
    JSON.stringify(pending.ownerDids) === JSON.stringify(expected.ownerDids);
}
