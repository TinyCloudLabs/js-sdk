import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  InvalidRestoredSessionError,
  RuntimeDelegationRejectedError,
  TinyCloudNode,
  UnsupportedSessionRestoreError,
  isCapabilitySubset,
  principalDidEquals,
  siweRuntimeDelegation,
  type PermissionEntry,
  type PortableDelegation,
  type TinyCloudSession,
} from "@tinycloud/node-sdk";
import { TCWSessionManager, importKey, initPanicHook } from "@tinycloud/node-sdk-wasm";
import { invokeOperation } from "@tinycloud/operations";

const PROFILE = "agent";
const MAX_CALLBACK_BYTES = 256 * 1024;
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
  readonly nodeHost: string;
  readonly openkeyHost: string;
  readonly approvalTtlSeconds: number;
  readonly delegationExpiry: string;
}

interface TenantProfile {
  readonly stateRoot: string;
  readonly sessionDid: string;
  readonly jwk: Record<string, unknown>;
}

interface PendingApproval {
  readonly version: 1;
  readonly nonce: string;
  readonly tenantId: string;
  readonly kind: "bootstrap" | "delegation";
  readonly requestId?: string;
  readonly permissions: PermissionEntry[];
  readonly ownerDids: string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ConnectStatus {
  readonly connected: boolean;
  readonly sessionDid: string;
  readonly approvalUrl?: string;
  readonly expiresAt?: string;
}

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

/** The callback stages `/connect/callback` names when it refuses an approval. */
export type ApprovalStage = "restore_approval" | "siwe_runtime_delegation" | "auth_import" | "activation";

/**
 * A callback stage refused the approval. `code` and `reason` are
 * server-authored identifiers for diagnostics; the message and cause may quote
 * callback or node data and are never sent or logged.
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

/** Why a callback was refused before its approval was read. */
export type ApprovalRequestDetail =
  | "state_missing"
  | "state_invalid"
  | "state_expired"
  | "state_not_pending"
  | "tenant_missing"
  | "body_invalid";

/**
 * The callback's state, tenant or body was refused before the approval was
 * read. `detail` is for server diagnostics only: callers get one uniform
 * response so they cannot probe whether a state is valid.
 */
export class ApprovalRequestError extends Error {
  readonly detail: ApprovalRequestDetail;

  constructor(detail: ApprovalRequestDetail, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ApprovalRequestError";
    this.detail = detail;
  }
}

export class RemoteTenantStore {
  readonly #config: RemoteStoreConfig;
  readonly #initializing = new Map<string, Promise<TenantProfile>>();

  constructor(config: RemoteStoreConfig) {
    this.#config = config;
  }

  tenantStateRoot(subject: string): string {
    return join(this.#config.stateDir, "tenants", this.#tenantId(subject));
  }

  async connectStatus(subject: string, ownerDids: readonly string[] = []): Promise<ConnectStatus> {
    const tenant = await this.#ensureTenant(subject);
    if (await this.#hasValidSession(tenant, ownerDids)) {
      return { connected: true, sessionDid: tenant.sessionDid };
    }
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
  ): Promise<unknown> {
    if (!isRecord(result) || result.status !== "authority_required") return result;
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
        fallback: "Open the approval URL, then retry the same MCP tool.",
      },
    };
  }

  async approvalRedirect(state: string): Promise<string> {
    const pending = await this.#readPending(state, false);
    const tenant = await this.#readTenant(pending.tenantId);
    const callback = new URL("/connect/callback", this.#config.publicUrl);
    callback.searchParams.set("state", state);
    const params = new URLSearchParams({
      did: tenant.sessionDid,
      callback: callback.toString(),
      host: this.#config.nodeHost,
      jwk: Buffer.from(JSON.stringify(publicJwk(tenant.jwk))).toString("base64url"),
      permissions: Buffer.from(JSON.stringify({
        permissions: pending.permissions,
        reason: [
          pending.kind === "bootstrap"
            ? "Connect this TinyCloud account to the hosted MCP delegate."
            : "Approve the exact capabilities requested by the TinyCloud MCP operation.",
          // Owner DIDs come from the verified OpenKey access token of the MCP
          // client that created this link, never from the link itself.
          ...(pending.ownerDids.length === 0
            ? []
            : [`Requested by TinyCloud account ${pending.ownerDids.join(", ")}; approve only if that is you.`]),
        ].join(" "),
      })).toString("base64url"),
      expiry: this.#config.delegationExpiry,
    });
    return `${this.#config.openkeyHost.replace(/\/+$/, "")}/delegate?${params.toString()}`;
  }

  async completeApproval(state: string, request: Request): Promise<void> {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_CALLBACK_BYTES) {
      throw new ApprovalRequestError("body_invalid", "Callback body is too large.");
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_CALLBACK_BYTES) {
      throw new ApprovalRequestError("body_invalid", "Callback body is too large.");
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ApprovalRequestError("body_invalid", "Callback body is invalid.", error);
    }
    if (!isRecord(data)) throw new ApprovalRequestError("body_invalid", "Callback body is invalid.");

    const pending = await this.#readPending(state, true);
    try {
      const tenant = await this.#readTenant(pending.tenantId);
      if (pending.kind === "bootstrap") {
        await this.#storeBootstrap(tenant, pending, data);
      } else {
        await this.#storeDelegation(tenant, pending, data);
      }
      await rm(this.#pendingPath(tenant.stateRoot, pending.nonce) + ".processing", { force: true });
    } catch (error) {
      await this.#restorePending(pending).catch(() => undefined);
      throw error;
    }
  }

  async #storeBootstrap(
    tenant: TenantProfile,
    pending: PendingApproval,
    data: Record<string, unknown>,
  ): Promise<void> {
    const { node, session } = await this.#restoreApproval(tenant, data);
    if (pending.ownerDids.length > 0 && !pending.ownerDids.some((did) => samePrincipal(node.did, did))) {
      throw new ApprovalOwnerMismatchError();
    }
    // The verifier reports one entry per signed action; the SDK subset check
    // judges each requested entry against every matching grant together.
    if (!isCapabilitySubset(pending.permissions, node.getVerifiedSessionCapabilities()).subset) {
      throw new Error("The approved delegation does not cover the requested account access.");
    }
    const profile = await readJson<Record<string, unknown>>(this.#profilePath(tenant.stateRoot));
    await secureWrite(this.#profilePath(tenant.stateRoot), {
      ...profile,
      ownerDid: normalizeDid(node.did),
      spaceId: session.spaceId,
    });
    await secureWrite(this.#sessionPath(tenant.stateRoot), {
      authMethod: "openkey",
      ...session,
    });
  }

  async #storeDelegation(
    tenant: TenantProfile,
    pending: PendingApproval,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (pending.requestId === undefined) throw new Error("Authority request is missing.");
    // Unlike bootstrap there is no empty-list exemption: a delegation is only
    // imported when its verified signer is the OAuth principal that asked.
    const { node, session } = await this.#restoreApproval(tenant, data);
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
  }

  /**
   * Verify the OpenKey callback as a SIWE session for this tenant's key. The
   * callback must carry the full signed proof (SIWE, signature, address and
   * chain), so the WASM verifier always runs: it binds the authorization bytes
   * and CID to the signed SIWE, and `node.did` is the wallet that signed
   * exactly the delegation being stored.
   */
  async #restoreApproval(
    tenant: TenantProfile,
    data: Record<string, unknown>,
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
    return { node, session };
  }

  async #ensureTenant(subject: string): Promise<TenantProfile> {
    const tenantId = this.#tenantId(subject);
    const current = this.#initializing.get(tenantId);
    if (current !== undefined) return current;
    const initializing = this.#initializeTenant(tenantId).finally(() => {
      this.#initializing.delete(tenantId);
    });
    this.#initializing.set(tenantId, initializing);
    return initializing;
  }

  async #hasValidSession(tenant: TenantProfile, ownerDids: readonly string[]): Promise<boolean> {
    const raw = await readJson<Record<string, unknown>>(this.#sessionPath(tenant.stateRoot));
    if (raw === null) return false;
    try {
      const node = new TinyCloudNode({ host: this.#config.nodeHost });
      await node.restoreSession(raw as unknown as TinyCloudSession);
      return samePrincipal(node.sessionDid, tenant.sessionDid) &&
        ownerDids.some((did) => samePrincipal(node.did, did));
    } catch {
      await rm(this.#sessionPath(tenant.stateRoot), { force: true });
      return false;
    }
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
    if (!(await fileExists(profilePath))) {
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
    }
    return { stateRoot, sessionDid, jwk };
  }

  async #readTenant(tenantId: string): Promise<TenantProfile> {
    if (!/^[a-f0-9]{64}$/.test(tenantId)) throw new ApprovalRequestError("state_invalid", "Approval state is invalid.");
    const stateRoot = join(this.#config.stateDir, "tenants", tenantId);
    const jwk = await readJson<Record<string, unknown>>(this.#keyPath(stateRoot));
    if (jwk === null) throw new ApprovalRequestError("tenant_missing", "The TinyCloud delegate no longer exists.");
    return { stateRoot, jwk, sessionDid: didFromJwk(jwk) };
  }

  async #createPending(
    subject: string,
    ownerDids: readonly string[],
    kind: PendingApproval["kind"],
    permissions: PermissionEntry[],
    requestId?: string,
  ): Promise<PendingApproval> {
    const tenant = await this.#ensureTenant(subject);
    const tenantId = this.#tenantId(subject);
    const reusable = await reusablePending(
      this.#pendingDirectory(tenant.stateRoot),
      { tenantId, kind, requestId, permissions, ownerDids: ownerDids.map(normalizeDid) },
    );
    if (reusable !== undefined) return reusable;
    const nonce = randomBytes(24).toString("base64url");
    const created = Date.now();
    const pending: PendingApproval = {
      version: 1,
      nonce,
      tenantId,
      kind,
      ...(requestId === undefined ? {} : { requestId }),
      permissions,
      ownerDids: ownerDids.map(normalizeDid),
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.#config.approvalTtlSeconds * 1000).toISOString(),
    };
    await secureWrite(this.#pendingPath(tenant.stateRoot, nonce), pending);
    return pending;
  }

  async #readPending(state: string, consume: boolean): Promise<PendingApproval> {
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
    const claimed = `${path}.processing`;
    if (consume) {
      try {
        await rename(path, claimed);
      } catch (error) {
        // No pending file to claim: already used, being processed, or never
        // issued. Other filesystem failures stay unclassified.
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        throw new ApprovalRequestError("state_not_pending", "Approval state is invalid or already used.", error);
      }
    }
    try {
      const pending = await readJson<PendingApproval>(consume ? claimed : path);
      if (pending === null || pending.version !== 1 || pending.tenantId !== tenantId || pending.nonce !== nonce) {
        throw new ApprovalRequestError("state_not_pending", "Approval state is invalid or already used.");
      }
      if (new Date(pending.expiresAt).getTime() <= Date.now()) {
        await rm(consume ? claimed : path, { force: true });
        throw new ApprovalRequestError("state_expired", "Approval state has expired.");
      }
      return pending;
    } catch (error) {
      if (consume) await rename(claimed, path).catch(() => undefined);
      throw error;
    }
  }

  async #restorePending(pending: PendingApproval): Promise<void> {
    const stateRoot = join(this.#config.stateDir, "tenants", pending.tenantId);
    const path = this.#pendingPath(stateRoot, pending.nonce);
    await rename(`${path}.processing`, path);
  }

  #connectUrl(pending: PendingApproval): string {
    const url = new URL("/connect", this.#config.publicUrl);
    url.searchParams.set("state", `${pending.tenantId}.${pending.nonce}.${this.#signState(pending.tenantId, pending.nonce)}`);
    return url.toString();
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

  #pendingPath(stateRoot: string, nonce: string): string {
    return join(this.#pendingDirectory(stateRoot), `${nonce}.json`);
  }

  #pendingDirectory(stateRoot: string): string {
    return join(stateRoot, ".tinycloud", "profiles", PROFILE, "pending");
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

function publicJwk(jwk: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...jwk };
  for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) delete copy[field];
  return copy;
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

async function fileExists(path: string): Promise<boolean> {
  return (await readJson<unknown>(path)) !== null;
}

async function reusablePending(
  directory: string,
  expected: Pick<PendingApproval, "tenantId" | "kind" | "requestId" | "permissions" | "ownerDids">,
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
    if (pending === null || new Date(pending.expiresAt).getTime() <= Date.now()) {
      await rm(path, { force: true });
      continue;
    }
    active.push(pending);
    if (samePendingRequest(pending, expected)) return pending;
  }
  if (active.length >= 64) {
    active.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    await rm(join(directory, `${active[0]!.nonce}.json`), { force: true });
  }
  return undefined;
}

function samePendingRequest(
  pending: PendingApproval,
  expected: Pick<PendingApproval, "tenantId" | "kind" | "requestId" | "permissions" | "ownerDids">,
): boolean {
  return pending.version === 1 && pending.tenantId === expected.tenantId &&
    pending.kind === expected.kind && pending.requestId === expected.requestId &&
    JSON.stringify(pending.permissions) === JSON.stringify(expected.permissions) &&
    JSON.stringify(pending.ownerDids) === JSON.stringify(expected.ownerDids);
}
