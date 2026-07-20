import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  TinyCloudNode,
  principalDidEquals,
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
        reason: pending.kind === "bootstrap"
          ? "Connect this TinyCloud account to the hosted MCP delegate."
          : "Approve the exact capabilities requested by the TinyCloud MCP operation.",
      })).toString("base64url"),
      expiry: this.#config.delegationExpiry,
    });
    return `${this.#config.openkeyHost.replace(/\/+$/, "")}/delegate?${params.toString()}`;
  }

  async completeApproval(state: string, request: Request): Promise<void> {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_CALLBACK_BYTES) throw new Error("Callback body is too large.");
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_CALLBACK_BYTES) throw new Error("Callback body is too large.");
    const data = JSON.parse(text) as unknown;
    if (!isRecord(data)) throw new Error("Callback body is invalid.");

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
    const session = sessionFromCallback(data, tenant.jwk);
    const node = new TinyCloudNode({ host: this.#config.nodeHost });
    await node.restoreSession(session);
    if (!samePrincipal(node.sessionDid, tenant.sessionDid)) {
      throw new Error("The approved delegation targets a different session.");
    }
    if (pending.ownerDids.length > 0 && !pending.ownerDids.some((did) => samePrincipal(node.did, did))) {
      throw new Error("The approved delegation belongs to a different OpenKey user.");
    }
    const granted = [...node.getVerifiedSessionCapabilities()];
    if (!permissionsCover(pending.permissions, granted)) {
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
    const delegation = portableFromCallback(data, pending.permissions, this.#config.nodeHost);
    const result = await invokeOperation(
      "tinycloud.auth.import",
      1,
      { profile: PROFILE, stateRoot: tenant.stateRoot },
      {
        requestId: pending.requestId,
        delegationCid: delegation.cid,
        delegation,
      },
    );
    if (result.status !== "ok") throw new Error("TinyCloud rejected the approved delegation.");
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
    if (!/^[a-f0-9]{64}$/.test(tenantId)) throw new Error("Approval state is invalid.");
    const stateRoot = join(this.#config.stateDir, "tenants", tenantId);
    const jwk = await readJson<Record<string, unknown>>(this.#keyPath(stateRoot));
    if (jwk === null) throw new Error("The TinyCloud delegate no longer exists.");
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
      throw new Error("Approval state is invalid.");
    }
    const expected = this.#signState(tenantId, nonce);
    const supplied = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) {
      throw new Error("Approval state is invalid.");
    }
    const stateRoot = join(this.#config.stateDir, "tenants", tenantId);
    const path = this.#pendingPath(stateRoot, nonce);
    const claimed = `${path}.processing`;
    if (consume) await rename(path, claimed);
    try {
      const pending = await readJson<PendingApproval>(consume ? claimed : path);
      if (pending === null || pending.version !== 1 || pending.tenantId !== tenantId || pending.nonce !== nonce) {
        throw new Error("Approval state is invalid or already used.");
      }
      if (new Date(pending.expiresAt).getTime() <= Date.now()) {
        await rm(consume ? claimed : path, { force: true });
        throw new Error("Approval state has expired.");
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

function sessionFromCallback(data: Record<string, unknown>, privateJwk: Record<string, unknown>) {
  const delegationHeader = data.delegationHeader;
  if (!isRecord(delegationHeader) || typeof delegationHeader.Authorization !== "string" ||
    typeof data.delegationCid !== "string" || typeof data.spaceId !== "string" ||
    typeof data.verificationMethod !== "string") {
    throw new Error("OpenKey returned an incomplete delegation.");
  }
  return {
    delegationHeader: { Authorization: delegationHeader.Authorization },
    delegationCid: data.delegationCid,
    spaceId: data.spaceId,
    jwk: privateJwk,
    verificationMethod: data.verificationMethod,
    ...(typeof data.address === "string" ? { address: data.address } : {}),
    ...(typeof data.chainId === "number" ? { chainId: data.chainId } : {}),
    ...(typeof data.siwe === "string" ? { siwe: data.siwe } : {}),
    ...(typeof data.signature === "string" ? { signature: data.signature } : {}),
  };
}

function portableFromCallback(
  data: Record<string, unknown>,
  permissions: PermissionEntry[],
  host: string,
): PortableDelegation {
  const primary = permissions.find((permission) => permission.service !== "tinycloud.encryption") ?? permissions[0];
  if (primary === undefined) throw new Error("The authority request has no permissions.");
  const session = sessionFromCallback(data, {});
  const expiry = delegationExpiry(data);
  return {
    cid: session.delegationCid,
    delegationHeader: session.delegationHeader,
    spaceId: session.spaceId,
    path: primary.path,
    actions: [...primary.actions],
    resources: permissions.map((permission) => ({
      service: permission.service.startsWith("tinycloud.")
        ? permission.service.slice("tinycloud.".length)
        : permission.service,
      space: permission.service === "tinycloud.encryption"
        ? requiredPermissionSpace(permission)
        : session.spaceId,
      path: permission.path,
      actions: [...permission.actions],
    })),
    expiry,
    delegateDID: session.verificationMethod,
    ownerAddress: typeof data.address === "string" ? data.address : "",
    chainId: typeof data.chainId === "number" ? data.chainId : 1,
    host,
  };
}

function delegationExpiry(data: Record<string, unknown>): Date {
  for (const key of ["expiry", "expiresAt", "expirationTime"]) {
    const parsed = parseDate(data[key]);
    if (parsed !== undefined) return parsed;
  }
  if (typeof data.siwe === "string") {
    const match = data.siwe.match(/^Expiration Time:\s*(.+)$/im);
    const parsed = parseDate(match?.[1]?.trim());
    if (parsed !== undefined) return parsed;
  }
  throw new Error("OpenKey did not return a delegation expiry.");
}

function permissionsCover(requested: PermissionEntry[], granted: PermissionEntry[]): boolean {
  return requested.every((request) => granted.some((grant) =>
    normalizeService(grant.service) === normalizeService(request.service) &&
    typeof grant.space === "string" && typeof request.space === "string" &&
    sameSpace(grant.space, request.space) &&
    grant.path === request.path &&
    request.actions.every((action) => grant.actions.includes(action))
  ));
}

function sameSpace(granted: string, requested: string): boolean {
  return granted === requested || granted.endsWith(`:${requested}`);
}

function normalizeService(service: string): string {
  return service.startsWith("tinycloud.") ? service : `tinycloud.${service}`;
}

function requiredPermissionSpace(permission: PermissionEntry): string {
  if (typeof permission.space !== "string") throw new Error("The authority request has no space.");
  return permission.space;
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

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date;
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
