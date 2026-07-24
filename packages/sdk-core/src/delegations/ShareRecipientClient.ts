import {
  ErrorCodes,
  KVService,
  ServiceContext,
  type FetchFunction,
  type IKVService,
  type InvokeFunction,
  type ServiceHeaders,
  type ServiceSession,
} from "@tinycloud/sdk-services";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import {
  decryptShareBytesAsync,
  openPublishedShareBlob,
  parseShareArtifact,
  parsePublishedShareEnvelope,
  parseLegacyPublishedShareEnvelope,
  parsePublishedShareLink,
  parseShareUrl,
  shareCapabilityAllows,
  intersectShareCapabilities,
  verifyShareCid,
  verifyPublishedShareCid,
  verifyShareEnvelope,
  type ShareAction,
  type ShareEnvelopeV2,
  type ShareLinkLocation,
  type ShareResource,
  type ShareCapabilityLike,
} from "./share-envelope";
import { MemoryShareCache, type ShareCache, type ShareCacheEntry } from "./ShareCache";
import { ShareAccessError, ShareConflict, type ShareAccessV2, type ShareDetachedProof, type ShareNativeInvokeResult, type SharePolicyBinding, type SharePolicySession, type ShareRecipientClientOptions, type ShareReadResult, type ShareListEntry, type ShareListResult } from "./recipient-types";

const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const NATIVE_MEDIA_TYPE = "application/vnd.tinycloud.share+json" as const;
const READ_INVOCATION_DOMAIN = "xyz.tinycloud.share/read-invocation/v1\0";
const POLICY_PRESENTATION_DOMAIN = "xyz.tinycloud.share/policy-presentation/v1\0";
const READ_TTL_MS = 60_000;

interface ResolvedArtifact {
  readonly location: ShareLinkLocation;
  readonly artifact: ReturnType<typeof parseShareArtifact>;
  readonly bytes: Uint8Array;
  readonly plaintext: Uint8Array;
}

function redactedCode(error: unknown): string {
  if (error instanceof ShareAccessError) return error.code;
  if (error instanceof ShareConflict) return error.code;
  const code = error && typeof error === "object" && "code" in error ? (error as { readonly code?: unknown }).code : undefined;
  if (typeof code !== "string") return "SHARE_INVALID";
  if (code === ErrorCodes.KV_PRECONDITION_FAILED || code === ErrorCodes.KV_CONFLICT || code === "412") return "SHARE_CONFLICT";
  if (code === "KV_NOT_FOUND" || code === "NOT_FOUND" || code === "404") return "SHARE_NOT_FOUND";
  if (code.includes("EXPIRED") || code === "expired") return "SHARE_EXPIRED";
  if (code.includes("REVOK")) return "SHARE_REVOKED";
  if (code.includes("AUTH") || code.includes("DENIED") || code === "403" || code === "401") return "SHARE_DENIED";
  if (code.includes("NETWORK") || code.includes("TIMEOUT") || code === "OFFLINE") return "SHARE_OFFLINE";
  if (["invalid-link", "invalid-envelope", "expired", "signature-invalid", "cid-mismatch", "origin-mismatch", "content-too-large", "encryption-required", "unsafe-plaintext"].includes(code)) return code;
  return code.startsWith("SHARE_") ? code : "SHARE_INVALID";
}

function asError(error: unknown): ShareAccessError {
  if (error instanceof ShareAccessError) return error;
  return new ShareAccessError(redactedCode(error));
}

function operationAction(action: "get" | "list" | "save"): ShareAction {
  return action === "get" ? "read" : action === "list" ? "list" : "edit";
}

function normalizePath(value: string): string {
  const parts = value.split("/");
  const invalidPart = parts.some((part, index) => part === ".." || part === "." || (part === "" && !(index === parts.length - 1 && value.endsWith("/"))));
  if (value === "" || value.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(value) || /%2f|%5c|%2e/i.test(value) || invalidPart) {
    throw new ShareAccessError("SHARE_INVALID_PATH");
  }
  return value;
}

function canonicalJsonForProof(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ShareAccessError("SHARE_SESSION_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForProof).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonForProof(object[key])}`).join(",")}}`;
  }
  throw new ShareAccessError("SHARE_SESSION_INVALID");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error("base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const decoded = typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("binary");
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) throw new Error("non-canonical base64url");
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomJti(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function digestCanonical(value: unknown): string {
  return bytesToBase64Url(sha256(new TextEncoder().encode(canonicalJsonForProof(value))));
}

function actionWire(action: "get" | "list" | "put"): string {
  return action === "get" ? "tinycloud.kv/get" : action === "list" ? "tinycloud.kv/list" : "tinycloud.kv/put";
}

function headersRecord(headers: ServiceHeaders | undefined): Record<string, string> {
  if (headers === undefined) return {};
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), value]));
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapProofResponse(value: Record<string, unknown>, key: "challenge" | "session"): { readonly message: Record<string, unknown>; readonly proof: unknown } {
  const candidates: Record<string, unknown>[] = [value];
  for (const wrapper of ["data", "result", "body", "response"] as const) {
    if (isRecord(value[wrapper])) candidates.push(value[wrapper]);
  }
  for (const candidate of candidates) {
    const message = candidate[key];
    if (isRecord(message)) {
      const proof = candidate.proof ?? value.proof ?? message.proof;
      if (proof !== undefined) return { message, proof };
    }
  }
  throw new ShareAccessError("SHARE_SESSION_INVALID", `Node ${key} response is missing its proof`);
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  throw new ShareAccessError("SHARE_SESSION_INVALID");
}

function compareBoundValue(left: unknown, right: unknown, message: string): void {
  if (left !== undefined && right !== undefined && canonicalValue(left) !== canonicalValue(right)) {
    throw new ShareAccessError("SHARE_SESSION_INVALID", message);
  }
}

function dateValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assertObjectKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new ShareAccessError("SHARE_SESSION_INVALID", `${label} contains an unknown field`);
}

function isBearerEnvelope(envelope: ShareEnvelopeV2): boolean {
  // Missing recipientKind is retained for old bearer artifacts. New policy
  // artifacts always carry the non-PII discriminator.
  return envelope.recipientKind === "bearer" || (envelope.recipientKind === undefined && envelope.encrypted && (envelope.authorizationTargetKind === undefined || envelope.authorizationTargetKind === "bearerKey"));
}

function nativeInvoke(session: ServiceSession, _service: string, _path: string, _action: string): ServiceHeaders {
  const authorization = session.delegationHeader?.Authorization;
  if (typeof authorization !== "string" || authorization.length === 0) throw new ShareAccessError("SHARE_SESSION_REQUIRED");
  return { Authorization: authorization };
}

export class ShareRecipientClient {
  private readonly fetchFn: FetchFunction;
  private readonly cache: ShareCache;
  private readonly now: () => Date;

  constructor(private readonly options: ShareRecipientClientOptions) {
    this.fetchFn = options.fetch ?? (globalThis.fetch.bind(globalThis) as FetchFunction);
    this.cache = options.cache ?? new MemoryShareCache();
    this.now = options.now ?? (() => new Date());
  }

  async open(link: string): Promise<ShareAccessV2> {
    try {
      const resolved = await this.resolve(link);
      const { envelope } = resolved.artifact;
      const { location } = resolved;
      const bearer = isBearerEnvelope(envelope);
      const policy = envelope.recipientKind === "exactEmail" || envelope.recipientKind === "emailDomain";
      const legacyBearer = !policy && envelope.recipientKind === undefined;
      if (envelope.authorizationTargetKind === "recipientDid") throw new ShareAccessError("SHARE_RECIPIENT_DID_UNSUPPORTED");
      if (policy && this.options.bearerSession !== undefined) throw new ShareAccessError("SHARE_POLICY_BEARER_MISMATCH");
      if (bearer && this.options.presentation !== undefined) throw new ShareAccessError("SHARE_BEARER_PRESENTATION_MISMATCH");

      const session = bearer || legacyBearer
        ? this.options.bearerSession
        : policy && this.options.establishPolicySession !== undefined
          ? await this.options.establishPolicySession({ envelope, presentation: this.options.presentation })
          : policy ? await this.establishPolicySession(envelope) : undefined;
      const kv = bearer || legacyBearer
        ? session === undefined ? undefined : this.createKV(envelope.origin, session as ServiceSession)
        : undefined;
      const policySession = policy ? session as SharePolicySession | undefined : undefined;
      if (policySession !== undefined) this.assertProvidedPolicySession(policySession, envelope);
      const advertisedCapability: ShareCapabilityLike = { spaceId: envelope.spaceId, resource: envelope.resource, actions: envelope.actions };
      const capability = policySession?.capability === undefined
        ? advertisedCapability
        : intersectShareCapabilities(advertisedCapability, policySession.capability);
      if (capability === undefined) throw new ShareAccessError("SHARE_CAPABILITY_EMPTY");

      const get = async (path = envelope.resource.kind === "exact" ? envelope.resource.path : ""): Promise<ShareReadResult> => {
        try {
          const resolvedPath = normalizePath(path);
          this.assertAllowed(capability, "get", resolvedPath);
          if (kv !== undefined) {
            const result = await kv.get<Uint8Array>(resolvedPath, { binary: true, maxResponseBytes: this.options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES });
            if (!result.ok) throw result.error;
            return { bytes: result.data.data, etag: result.data.headers.etag, contentType: result.data.headers.contentType, size: result.data.data.byteLength };
          }
          if (policySession !== undefined) return this.nativeGet(envelope, policySession, resolvedPath);
          if (policy || envelope.resource.kind !== "exact" || resolvedPath !== envelope.resource.path) throw new ShareAccessError("SHARE_SESSION_REQUIRED");
          return { bytes: resolved.plaintext.slice(), contentType: envelope.content.mimeType, size: resolved.plaintext.byteLength };
        } catch (error) {
          throw asError(error);
        }
      };

      const listChildren = async (input: { readonly path?: string; readonly limit?: number; readonly cursor?: string } = {}): Promise<ShareListResult> => {
        try {
          const scope = normalizePath(input.path ?? envelope.resource.path);
          this.assertAllowed(capability, "list", scope);
          if (kv === undefined && policySession === undefined) throw new ShareAccessError("SHARE_SESSION_REQUIRED");
          if (policySession !== undefined) return this.nativeList(envelope, policySession, scope, input.limit, input.cursor);
          const result = await kv!.list({ path: scope, limit: input.limit, cursor: input.cursor });
          if (!result.ok) throw result.error;
          // Node is authoritative for direct-child filtering and pagination.
          return { keys: result.data.keys, truncated: result.data.truncated, nextCursor: result.data.nextCursor };
        } catch (error) {
          throw asError(error);
        }
      };

      const save = async (path: string, bytes: Uint8Array, input: { readonly etag: string; readonly contentType?: string }): Promise<{ readonly etag?: string }> => {
        try {
          const resolvedPath = normalizePath(path);
          this.assertAllowed(capability, "save", resolvedPath);
          if (kv === undefined && policySession === undefined) throw new ShareAccessError("SHARE_SESSION_REQUIRED");
          if (policySession !== undefined) return this.nativeSave(envelope, policySession, resolvedPath, bytes, input);
          const result = await kv!.put(resolvedPath, bytes, { contentType: input.contentType ?? envelope.content.mimeType, ifMatch: input.etag });
          if (!result.ok) {
            if (result.error.code === ErrorCodes.KV_PRECONDITION_FAILED || result.error.code === ErrorCodes.KV_CONFLICT) throw new ShareConflict(resolvedPath, result.error.meta?.etag as string | undefined);
            throw result.error;
          }
          return { etag: result.data.headers.etag };
        } catch (error) {
          if (error instanceof ShareConflict) throw error;
          throw asError(error);
        }
      };

      return { kind: "share-v2", envelope, location: { ...location, key: undefined }, resource: envelope.resource, actions: envelope.actions, expiresAt: new Date(envelope.expiresAt), kv, get, listChildren, save };
    } catch (error) {
      throw asError(error);
    }
  }

  private createKV(origin: string, session: ServiceSession): IKVService {
    if (this.options.createKVService !== undefined) {
      return this.options.createKVService({ hosts: [origin], session, invoke: this.options.invoke ?? nativeInvoke, fetch: this.fetchFn });
    }
    const context = new ServiceContext({ hosts: [origin], session, invoke: this.options.invoke ?? nativeInvoke, fetch: this.fetchFn });
    const service = new KVService({ prefix: "" });
    context.registerService("kv", service);
    service.initialize(context);
    return service;
  }

  private async nativeGet(envelope: ShareEnvelopeV2, session: SharePolicySession, path: string): Promise<ShareReadResult> {
    const result = await this.invokeNative({ envelope, session, action: "get", resource: path, mediaType: "application/vnd.tinycloud.share+json" });
    if (result.status === 404) throw new ShareAccessError("SHARE_NOT_FOUND");
    if (result.status === 401 || result.status === 403) throw new ShareAccessError("SHARE_DENIED");
    if (result.status < 200 || result.status >= 300 || result.bytes === undefined) throw new ShareAccessError("SHARE_READ_FAILED");
    this.verifyNativeResponse(result.bytes, result.headers);
    return { bytes: result.bytes, etag: result.headers?.etag, contentType: result.headers?.["content-type"] ?? envelope.content.mimeType, size: result.bytes.byteLength };
  }

  private async nativeList(envelope: ShareEnvelopeV2, session: SharePolicySession, path: string, limit?: number, cursor?: string): Promise<ShareListResult> {
    const result = await this.invokeNative({ envelope, session, action: "list", resource: path, limit, cursor, mediaType: "application/vnd.tinycloud.share+json" });
    if (result.status === 401 || result.status === 403) throw new ShareAccessError("SHARE_DENIED");
    if (result.status < 200 || result.status >= 300 || result.keys === undefined) throw new ShareAccessError("SHARE_LIST_FAILED");
    return { keys: result.keys, entries: result.entries, truncated: result.truncated, nextCursor: result.nextCursor };
  }

  private async nativeSave(envelope: ShareEnvelopeV2, session: SharePolicySession, path: string, bytes: Uint8Array, input: { readonly etag: string; readonly contentType?: string }): Promise<{ readonly etag?: string }> {
    const contentType = input.contentType ?? envelope.content.mimeType;
    if (contentType !== envelope.content.mimeType && !/^text\/(?:plain|markdown)(?:;|$)/i.test(contentType)) throw new ShareAccessError("SHARE_CONTENT_TYPE_INVALID");
    const result = await this.invokeNative({ envelope, session, action: "put", resource: path, body: bytes, bodyDigest: bytesToBase64Url(sha256(bytes)), contentType, ifMatch: input.etag, mediaType: "application/vnd.tinycloud.share+json" });
    if (result.status === 412 || result.status === 409) throw new ShareConflict(path, result.headers?.etag);
    if (result.status === 401 || result.status === 403) throw new ShareAccessError("SHARE_DENIED");
    if (result.status < 200 || result.status >= 300) throw new ShareAccessError("SHARE_WRITE_FAILED");
    return { etag: result.headers?.etag };
  }

  private async invokeNative(input: Parameters<NonNullable<ShareRecipientClientOptions["nativeInvoke"]>>[0]): Promise<ShareNativeInvokeResult> {
    if (this.options.nativeInvoke !== undefined) return this.options.nativeInvoke(input);
    const base = input.envelope.origin.replace(/\/$/, "");
    if (input.mediaType !== NATIVE_MEDIA_TYPE) throw new ShareAccessError("SHARE_NATIVE_MEDIA_TYPE_INVALID");
    const session = input.session;
    const binding = this.options.policyBinding;
    const required = (value: unknown, name: string): string => {
      if (typeof value !== "string" || value.length === 0) throw new ShareAccessError("SHARE_SESSION_INVALID", `Node session ${name} is missing`);
      return value;
    };
    const contentSource = session.contentSource ?? binding?.contentSource;
    if (!isRecord(contentSource)) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node content source is missing");
    const now = this.now().getTime();
    const expiry = Math.min(
      now + READ_TTL_MS,
      dateValue(session.expiresAt) ?? now,
      dateValue(input.envelope.expiresAt) ?? now,
    );
    if (!Number.isFinite(expiry) || expiry <= now) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node read expiry is invalid");
    const selectedAction = actionWire(input.action);
    if (typeof session.action === "string" && session.action !== selectedAction && !(session.actions ?? []).includes(selectedAction)) {
      throw new ShareAccessError("SHARE_SESSION_ACTION_MISMATCH");
    }
    const invocationBase: Record<string, unknown> = {
      type: "TinyCloudShareReadInvocation",
      version: 1,
      sessionId: required(session.sessionId, "sessionId"),
      shareCid: required(session.shareCid ?? binding?.shareCid, "shareCid"),
      shareId: required(session.shareId ?? binding?.shareId, "shareId"),
      delegationCid: required(session.delegationCid ?? binding?.delegationCid, "delegationCid"),
      policyCid: required(session.policyCid ?? binding?.policyCid, "policyCid"),
      authorityMaterialHandle: required(session.authorityMaterialHandle ?? binding?.authorityMaterialHandle, "authorityMaterialHandle"),
      authorityMaterialDigest: required(session.authorityMaterialDigest ?? binding?.authorityMaterialDigest, "authorityMaterialDigest"),
      contentSource,
      contentSourceDigest: required(session.contentSourceDigest ?? binding?.contentSourceDigest, "contentSourceDigest"),
      holderDid: required(session.holderDid, "holderDid"),
      targetOrigin: required(session.targetOrigin ?? binding?.targetOrigin ?? input.envelope.origin, "targetOrigin"),
      nodeAudience: required(session.nodeAudience ?? binding?.nodeAudience, "nodeAudience"),
      action: session.action ?? binding?.action ?? selectedAction,
      ...(session.actions === undefined && binding?.actions === undefined ? {} : { actions: [...(session.actions ?? binding?.actions ?? [])] }),
      resource: input.resource,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiry).toISOString(),
      jti: randomJti(),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.bodyDigest === undefined ? {} : { bodyDigest: input.bodyDigest }),
      ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
    };
    const readPreimage: Record<string, unknown> = {
      sessionId: invocationBase.sessionId,
      delegationCid: invocationBase.delegationCid,
      authorityMaterialHandle: invocationBase.authorityMaterialHandle,
      authorityMaterialDigest: invocationBase.authorityMaterialDigest,
      contentSource,
      contentSourceDigest: invocationBase.contentSourceDigest,
      action: invocationBase.action,
      ...(invocationBase.actions === undefined ? {} : { actions: invocationBase.actions }),
      resource: invocationBase.resource,
      invocation: invocationBase,
    };
    const requestBodyDigest = digestCanonical(readPreimage);
    const invocation: Record<string, unknown> = { ...invocationBase, requestBodyDigest };
    const signer = this.options.holderSigner ?? session.holderSigner;
    if (signer === undefined) throw new ShareAccessError("SHARE_NATIVE_SIGNER_REQUIRED");
    const proof = await signer({ domain: READ_INVOCATION_DOMAIN, message: invocation });
    this.assertDetachedProof(proof);
    const request: Record<string, unknown> = {
      sessionId: invocation.sessionId,
      delegationCid: invocation.delegationCid,
      authorityMaterialHandle: invocation.authorityMaterialHandle,
      authorityMaterialDigest: invocation.authorityMaterialDigest,
      contentSource,
      contentSourceDigest: invocation.contentSourceDigest,
      action: invocation.action,
      ...(invocation.actions === undefined ? {} : { actions: invocation.actions }),
      resource: invocation.resource,
      requestBodyDigest,
      invocation,
      proof,
    };
    const body = {
      request,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.body === undefined ? {} : { body: bytesToBase64Url(input.body) }),
      ...(input.bodyDigest === undefined ? {} : { bodyDigest: input.bodyDigest }),
      ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
    };
    const signed = this.options.signNativeInvoke === undefined
      ? undefined
      : await this.options.signNativeInvoke({ envelope: input.envelope, session: input.session, request: body });
    const response = await this.fetchFn(`${base}/invoke`, {
      method: "POST",
      headers: { ...headersRecord(signed), "content-type": input.mediaType, accept: input.mediaType },
      body: JSON.stringify(body),
      redirect: "error",
    });
    const headers: Record<string, string> = {};
    for (const name of ["etag", "content-type", "content-digest", "x-tinycloud-content-digest", "x-tinycloud-cid", "x-tinycloud-content-cid", "x-tinycloud-next-cursor"]) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const contentType = response.headers.get("content-type") ?? "";
    let value: unknown;
    if (contentType.includes("json")) {
      try { value = await response.json(); } catch { value = undefined; }
    }
    const record = isRecord(value) ? value : {};
    const etag = typeof record.etag === "string" ? record.etag : headers.etag;
    if (etag !== undefined) headers.etag = etag;
    if (input.action === "list") {
      const rawEntries = Array.isArray(record.entries) ? record.entries : Array.isArray(record.paths) ? record.paths : [];
      const entries: ShareListEntry[] = rawEntries.flatMap((entry): ShareListEntry[] => {
        if (typeof entry === "string") return [{ path: entry, kind: entry.endsWith("/") ? "folder" : "file" }];
        if (isRecord(entry) && typeof entry.path === "string" && (entry.kind === "file" || entry.kind === "folder")) return [{ path: entry.path, kind: entry.kind }];
        return [];
      });
      return {
        status: response.status,
        headers,
        keys: entries.map((entry) => entry.path),
        entries,
        truncated: typeof record.truncated === "boolean" ? record.truncated : record.nextCursor !== undefined,
        nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : response.headers.get("x-tinycloud-next-cursor") ?? undefined,
      };
    }
    if (input.action === "get" && typeof record.content === "string") {
      try {
        const bytes = base64UrlToBytes(record.content);
        if (typeof record.bodyDigest === "string" && record.bodyDigest !== bytesToBase64Url(sha256(bytes))) throw new ShareAccessError("SHARE_RESPONSE_INTEGRITY");
        return { status: response.status, headers, bytes };
      } catch (error) {
        if (error instanceof ShareAccessError) throw error;
        throw new ShareAccessError("SHARE_RESPONSE_INVALID");
      }
    }
    return { status: response.status, headers };
  }

  private assertDetachedProof(value: unknown): asserts value is ShareDetachedProof {
    const proof = this.requireObject(value, "holder proof");
    assertObjectKeys(proof, ["alg", "kid", "signature"], "holder proof");
    if (proof.alg !== "EdDSA" || typeof proof.kid !== "string" || typeof proof.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) {
      throw new ShareAccessError("SHARE_NATIVE_PROOF_INVALID");
    }
  }

  private defaultNativeHeaders(session: SharePolicySession, action: "get" | "list" | "put", resource: string, request: Record<string, unknown>): ServiceHeaders {
    const authorization = typeof session.authorization === "string"
      ? session.authorization
      : isRecord(session.delegationHeader) && typeof session.delegationHeader.Authorization === "string"
        ? session.delegationHeader.Authorization
        : undefined;
    const invokeSession = {
      delegationHeader: { Authorization: authorization ?? "" },
      delegationCid: typeof session.delegationCid === "string" ? session.delegationCid : session.sessionId,
      spaceId: typeof session.spaceId === "string" ? session.spaceId : "share",
      verificationMethod: typeof session.verificationMethod === "string" ? session.verificationMethod : session.holderDid,
      jwk: isRecord(session.jwk) ? session.jwk : {},
    } as ServiceSession;
    if (this.options.invoke === undefined) {
      if (authorization === undefined) throw new ShareAccessError("SHARE_NATIVE_INVOKE_REQUIRED");
      return { Authorization: authorization };
    }
    return this.options.invoke(invokeSession, "share", resource, `tinycloud.share/${action}`, [{
      shareSessionId: session.sessionId,
      shareRequest: request,
    }]);
  }

  private verifyNativeResponse(bytes: Uint8Array, headers: Readonly<Record<string, string | undefined>> | undefined): void {
    const digest = headers?.["x-tinycloud-content-digest"] ?? headers?.["content-digest"];
    if (digest !== undefined && digest !== bytesToBase64Url(sha256(bytes)) && digest !== `sha-256=:${bytesToBase64Url(sha256(bytes))}:`) {
      throw new ShareAccessError("SHARE_RESPONSE_INTEGRITY");
    }
    const cid = headers?.["x-tinycloud-content-cid"] ?? headers?.["x-tinycloud-cid"];
    if (cid !== undefined && !verifyPublishedShareCid(cid, bytes) && !verifyShareCid(cid, bytes)) throw new ShareAccessError("SHARE_RESPONSE_INTEGRITY");
  }

  private async establishPolicySession(envelope: ShareEnvelopeV2): Promise<SharePolicySession> {
    if (this.options.presentation === undefined) throw new ShareAccessError("SHARE_PRESENTATION_REQUIRED");
    const base = envelope.origin.replace(/\/$/, "");
    const challengeUrl = this.options.policyRoutes?.challenge ?? `${base}/share/v1/policy/challenges`;
    const sessionUrl = this.options.policyRoutes?.session ?? `${base}/share/v1/policy/session`;
    const presentation = this.options.presentation;
    if (presentation === undefined || typeof presentation !== "object" || presentation === null) {
      throw new ShareAccessError("SHARE_PRESENTATION_REQUIRED");
    }
    const input = presentation as Record<string, unknown>;
    const request = input.challengeRequest ?? this.buildChallengeRequest(envelope, input);
    if (request === undefined || typeof request !== "object" || request === null || Array.isArray(request)) throw new ShareAccessError("SHARE_SESSION_INVALID", "a Node policy challenge request is required");
    if (this.options.policyBinding !== undefined) this.assertStrictChallengeRequest(request as Record<string, unknown>);
    const challengeResponse = await this.postJson(challengeUrl, request);
    const challengeEnvelope = unwrapProofResponse(challengeResponse, "challenge");
    const challenge = challengeEnvelope.message;
    this.verifyNodeProof(challenge, challengeEnvelope.proof, "xyz.tinycloud.share/policy-challenge/v1\0");
    this.assertChallengeRequestBinding(request as Readonly<Record<string, unknown>>, challenge);
    this.assertChallengeFresh(challenge);

    const builder = this.options.buildPolicySessionRequest;
    const sessionRequest = builder === undefined
      ? await this.buildDefaultPolicySessionRequest(presentation, challenge)
      : await builder({ envelope, challenge, challengeRequest: request as Readonly<Record<string, unknown>> });
    if (sessionRequest === undefined || typeof sessionRequest !== "object" || sessionRequest === null || Array.isArray(sessionRequest)) throw new ShareAccessError("SHARE_SESSION_INVALID", "the policy session builder returned an invalid request");
    if (this.options.policyBinding !== undefined) this.assertStrictSessionRequest(sessionRequest as Record<string, unknown>);
    const sessionResponse = await this.postJson(sessionUrl, sessionRequest);
    const sessionEnvelope = unwrapProofResponse(sessionResponse, "session");
    const session = sessionEnvelope.message;
    this.verifyNodeProof(session, sessionEnvelope.proof, "xyz.tinycloud.share/policy-session/v1\0");
    this.assertSessionBinding(session, envelope, request, challenge, sessionRequest);
    return {
      ...session,
      sessionId: this.requiredString(session, "sessionId"),
      ...(typeof session.shareCid === "string" ? { shareCid: session.shareCid } : {}),
      ...(typeof session.shareId === "string" ? { shareId: session.shareId } : {}),
      ...(typeof session.policyCid === "string" ? { policyCid: session.policyCid } : {}),
      holderDid: this.requiredString(session, "holderDid"),
      expiresAt: this.requiredString(session, "expiresAt"),
      ...(session.capability !== undefined ? { capability: this.parseSessionCapability(session.capability) } : {}),
      ...(this.options.policyBinding ?? {}),
      ...(isRecord(sessionRequest) && typeof sessionRequest.credential === "string" ? { credential: sessionRequest.credential } : {}),
      ...(isRecord(sessionRequest) && sessionRequest.holderBinding !== undefined ? { holderBinding: sessionRequest.holderBinding } : {}),
      ...(isRecord(sessionRequest) && typeof sessionRequest.readSignerDid === "string" ? { readSignerDid: sessionRequest.readSignerDid } : {}),
      ...(this.options.holderSigner === undefined ? {} : { holderSigner: this.options.holderSigner }),
    };
  }

  private buildChallengeRequest(envelope: ShareEnvelopeV2, presentation: Record<string, unknown>): Record<string, unknown> {
    const binding = this.options.policyBinding;
    if (binding === undefined) throw new ShareAccessError("SHARE_SESSION_INVALID", "a Node policy challenge request is required");
    const holderDid = typeof presentation.holderDid === "string" ? presentation.holderDid : binding.holderDid;
    if (holderDid === undefined) throw new ShareAccessError("SHARE_SESSION_INVALID", "the holder DID is required");
    const action = binding.action ?? binding.actions?.[0] ?? "tinycloud.kv/get";
    const body: Record<string, unknown> = {
      shareCid: binding.shareCid,
      shareId: binding.shareId,
      delegationCid: binding.delegationCid,
      authorityMaterialHandle: binding.authorityMaterialHandle,
      authorityMaterialDigest: binding.authorityMaterialDigest,
      policyCid: binding.policyCid,
      contentSource: binding.contentSource,
      contentSourceDigest: binding.contentSourceDigest,
      holderDid,
      targetOrigin: binding.targetOrigin || envelope.origin,
      nodeAudience: binding.nodeAudience,
      action,
      ...(binding.actions === undefined ? {} : { actions: [...binding.actions] }),
      resource: binding.resource,
    };
    return { ...body, requestBodyDigest: digestCanonical(body) };
  }

  private assertStrictChallengeRequest(request: Record<string, unknown>): void {
    assertObjectKeys(request, ["shareCid", "shareId", "delegationCid", "authorityMaterialHandle", "authorityMaterialDigest", "policyCid", "contentSource", "contentSourceDigest", "holderDid", "targetOrigin", "nodeAudience", "action", "actions", "resource", "requestBodyDigest"], "Node challenge request");
    for (const key of ["shareCid", "shareId", "delegationCid", "authorityMaterialHandle", "authorityMaterialDigest", "policyCid", "contentSourceDigest", "holderDid", "targetOrigin", "nodeAudience", "resource", "requestBodyDigest"] as const) {
      if (typeof request[key] !== "string" || request[key].length === 0) throw new ShareAccessError("SHARE_SESSION_INVALID", `Node challenge ${key} is invalid`);
    }
    if (!isRecord(request.contentSource) || typeof request.action !== "string") throw new ShareAccessError("SHARE_SESSION_INVALID", "Node challenge source is invalid");
    if (request.actions !== undefined && (!Array.isArray(request.actions) || request.actions.some((action) => typeof action !== "string"))) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node challenge actions are invalid");
    const { requestBodyDigest: _digest, ...body } = request;
    if (request.requestBodyDigest !== digestCanonical(body)) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node challenge digest is invalid");
  }

  private assertStrictSessionRequest(request: Record<string, unknown>): void {
    assertObjectKeys(request, ["presentation", "credential", "proof", "holderBinding", "readSignerDid"], "Node session request");
    if (!isRecord(request.presentation) || typeof request.credential !== "string" || request.credential.length === 0 || !isRecord(request.proof) || request.holderBinding === undefined || typeof request.readSignerDid !== "string") throw new ShareAccessError("SHARE_SESSION_INVALID", "Node session request is incomplete");
    this.assertDetachedProof(request.proof);
  }

  private parseSessionCapability(value: unknown): ShareCapabilityLike {
    const object = this.requireObject(value, "session capability");
    if (typeof object.spaceId !== "string") throw new ShareAccessError("SHARE_SESSION_INVALID", "session capability space is invalid");
    if (!Array.isArray(object.actions) || object.actions.some((action) => !["read", "list", "edit"].includes(action as string))) throw new ShareAccessError("SHARE_SESSION_INVALID", "session capability actions are invalid");
    const resource = this.requireObject(object.resource, "session capability resource");
    if ((resource.kind !== "exact" && resource.kind !== "prefix") || typeof resource.path !== "string") throw new ShareAccessError("SHARE_SESSION_INVALID", "session capability resource is invalid");
    return { spaceId: object.spaceId, actions: [...new Set(object.actions)] as ShareAction[], resource: { kind: resource.kind, path: resource.path } as ShareResource };
  }

  private assertProvidedPolicySession(session: SharePolicySession, envelope: ShareEnvelopeV2): void {
    if (typeof session.sessionId !== "string" || typeof session.holderDid !== "string" || dateValue(session.expiresAt) === undefined || dateValue(session.expiresAt)! <= this.now().getTime() || dateValue(session.expiresAt)! > (dateValue(envelope.expiresAt) ?? 0)) {
      throw new ShareAccessError("SHARE_SESSION_INVALID");
    }
    const binding = this.options.policyBinding;
    if (binding === undefined) return;
    if (binding.targetOrigin !== envelope.origin || binding.resource !== envelope.resource.path || binding.expiresAt !== undefined && binding.expiresAt !== envelope.expiresAt) {
      throw new ShareAccessError("SHARE_SESSION_INVALID");
    }
    for (const [key, expected] of Object.entries({
      shareCid: binding.shareCid,
      shareId: binding.shareId,
      delegationCid: binding.delegationCid,
      authorityMaterialHandle: binding.authorityMaterialHandle,
      authorityMaterialDigest: binding.authorityMaterialDigest,
      policyCid: binding.policyCid,
      contentSourceDigest: binding.contentSourceDigest,
      targetOrigin: binding.targetOrigin,
      nodeAudience: binding.nodeAudience,
      resource: binding.resource,
    })) compareBoundValue((session as Record<string, unknown>)[key], expected, `Node session ${key} is not bound to the policy`);
    if (session.contentSource !== undefined) compareBoundValue(session.contentSource, binding.contentSource, "Node session content source is not bound to the policy");
  }

  private async buildDefaultPolicySessionRequest(presentation: unknown, challenge: Record<string, unknown>): Promise<unknown> {
    if (!isRecord(presentation)) throw new ShareAccessError("SHARE_SESSION_INVALID", "a nonce-bound policy session builder is required");
    if (!isRecord(presentation.sessionRequest)) {
      const binding = this.options.policyBinding;
      const credential = typeof presentation.credential === "string" ? presentation.credential : undefined;
      const holderDid = typeof presentation.holderDid === "string" ? presentation.holderDid : binding?.holderDid;
      const holderBinding = presentation.holderBinding;
      const readSignerDid = typeof presentation.readSignerDid === "string" ? presentation.readSignerDid : holderDid;
      const signer = this.options.holderSigner;
      if (binding === undefined || credential === undefined || holderDid === undefined || holderBinding === undefined || readSignerDid === undefined || signer === undefined) {
        throw new ShareAccessError("SHARE_SESSION_INVALID", "a nonce-bound policy session builder is required");
      }
      const action = binding.action ?? binding.actions?.[0] ?? "tinycloud.kv/get";
      const policyPresentation: Record<string, unknown> = {
        type: "TinyCloudSharePolicyPresentation",
        version: 1,
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        shareCid: binding.shareCid,
        shareId: binding.shareId,
        delegationCid: binding.delegationCid,
        authorityMaterialHandle: binding.authorityMaterialHandle,
        authorityMaterialDigest: binding.authorityMaterialDigest,
        policyCid: binding.policyCid,
        contentSource: binding.contentSource,
        contentSourceDigest: binding.contentSourceDigest,
        holderDid,
        targetOrigin: binding.targetOrigin,
        nodeAudience: binding.nodeAudience,
        enforcerDid: challenge.enforcerDid,
        credentialDigest: typeof presentation.credentialDigest === "string" ? presentation.credentialDigest : bytesToBase64Url(sha256(new TextEncoder().encode(credential))),
        action,
        ...(binding.actions === undefined ? {} : { actions: [...binding.actions] }),
        resource: binding.resource,
        requestBodyDigest: challenge.requestBodyDigest,
        issuedAt: new Date(this.now()).toISOString(),
        expiresAt: challenge.expiresAt,
        jti: randomJti(),
      };
      const proof = await signer({ domain: POLICY_PRESENTATION_DOMAIN, message: policyPresentation });
      this.assertDetachedProof(proof);
      return { presentation: policyPresentation, credential, proof, holderBinding, readSignerDid };
    }
    const request = structuredClone(presentation.sessionRequest) as Record<string, unknown>;
    const candidate = isRecord(request.presentation) ? request.presentation : request;
    if (typeof candidate.holderDid !== "string") throw new ShareAccessError("SHARE_SESSION_INVALID", "the policy presentation holder is invalid");
    candidate.nonce = challenge.nonce;
    if (typeof challenge.challengeId === "string") candidate.challengeId = challenge.challengeId;
    if (candidate.audience === undefined && typeof challenge.audience === "string") candidate.audience = challenge.audience;
    return request;
  }

  private async postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error" });
    if (!response.ok) throw new ShareAccessError(response.status === 401 || response.status === 403 ? "SHARE_DENIED" : "SHARE_SESSION_FAILED");
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShareAccessError("SHARE_SESSION_INVALID");
    return value as Record<string, unknown>;
  }

  private requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShareAccessError("SHARE_SESSION_INVALID", `${label} is invalid`);
    return value as Record<string, unknown>;
  }

  private requiredString(value: Record<string, unknown>, key: string, fallback?: string): string {
    const result = value[key] ?? fallback;
    if (typeof result !== "string" || result.length === 0) throw new ShareAccessError("SHARE_SESSION_INVALID", `session ${key} is invalid`);
    return result;
  }

  private verifyNodeProof(message: Record<string, unknown>, proof: unknown, domain: string): void {
    const detached = this.requireObject(proof, "proof");
    const isJwsProof = detached.alg === "EdDSA" && typeof detached.kid === "string" && typeof detached.signature === "string";
    const isEd25519Proof = detached.algorithm === "Ed25519" && typeof detached.signerDid === "string" && typeof detached.value === "string";
    if (!isJwsProof && !isEd25519Proof) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node proof is invalid");
    if (isJwsProof) assertObjectKeys(detached, ["alg", "kid", "signature"], "Node proof");
    if (isEd25519Proof) assertObjectKeys(detached, ["algorithm", "signerDid", "value"], "Node proof");
    const signerDid = isJwsProof
      ? this.options.trustedSignerDids?.find((did) => detached.kid === `${did}#${did.slice("did:key:".length)}`)
      : this.options.trustedSignerDids?.find((did) => did === detached.signerDid);
    if (signerDid === undefined) throw new ShareAccessError("SHARE_SIGNER_UNTRUSTED");
    const encoded = signerDid.slice("did:key:".length);
    if (!signerDid.startsWith("did:key:") || !encoded.startsWith("z")) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node signer is invalid");
    let key: Uint8Array;
    let signature: Uint8Array;
    try {
      const decoded = base58btc.decode(encoded);
      if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) throw new Error("key");
      key = decoded.slice(2);
      signature = base64UrlToBytes((isJwsProof ? detached.signature : detached.value) as string);
    } catch {
      throw new ShareAccessError("SHARE_SESSION_INVALID", "Node proof encoding is invalid");
    }
    if ((isJwsProof && detached.kid !== `${signerDid}#${encoded}`) || (isEd25519Proof && detached.signerDid !== signerDid) || signature.length !== 64) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node proof binding is invalid");
    const bytes = new TextEncoder().encode(`${domain}${canonicalJsonForProof(message)}`);
    if (!ed25519.verify(signature, bytes, key)) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node proof signature is invalid");
  }

  private assertChallengeRequestBinding(request: Readonly<Record<string, unknown>>, challenge: Record<string, unknown>): void {
    const source = isRecord(request.body) ? request.body : request;
    for (const key of ["policyId", "shareId", "shareCid", "delegationCid", "authorityMaterialHandle", "authorityMaterialDigest", "policyCid", "contentSource", "contentSourceDigest", "holderDid", "targetOrigin", "nodeAudience", "audience", "resource", "action", "actions"] as const) {
      compareBoundValue(source[key], challenge[key], `Node challenge ${key} is not bound to the request`);
    }
    if (typeof challenge.challengeId !== "string" || challenge.challengeId.length === 0 || typeof challenge.nonce !== "string" || challenge.nonce.length < 16) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node challenge identity is invalid");
    const claimed = source.requestBodyDigest;
    if (typeof claimed === "string") {
      const { requestBodyDigest: _ignored, ...body } = source;
      compareBoundValue(claimed, digestCanonical(body), "Node challenge request digest is invalid");
      compareBoundValue(challenge.requestBodyDigest, claimed, "Node challenge request digest is not bound");
    }
    if (challenge.requestDigest !== undefined) compareBoundValue(challenge.requestDigest, claimed, "Node challenge request digest is invalid");
  }

  private assertChallengeFresh(challenge: Record<string, unknown>): void {
    const expiresAt = dateValue(challenge.challengeExpiresAt ?? challenge.expiresAt);
    if (expiresAt === undefined || expiresAt <= this.now().getTime()) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node challenge expiry is invalid");
  }

  private assertSessionBinding(session: Record<string, unknown>, envelope: ShareEnvelopeV2, request: unknown, challenge: Record<string, unknown>, sessionRequest: unknown): void {
    const requestObject = this.requireObject(request, "challenge request");
    const sessionRequestObject = this.requireObject(sessionRequest, "session request");
    const requestBinding = isRecord(requestObject.body) ? requestObject.body : requestObject;
    const presentation = isRecord(sessionRequestObject.presentation) ? sessionRequestObject.presentation : sessionRequestObject;
    const holderDid = typeof presentation.holderDid === "string"
      ? presentation.holderDid
      : isRecord(presentation.holder) && typeof presentation.holder.did === "string" ? presentation.holder.did : undefined;
    if (holderDid !== undefined) compareBoundValue(holderDid, session.holderDid, "Node session holder is not bound to the presentation");
    if (isRecord(presentation.holderBinding) && typeof presentation.holderBinding.holderDid === "string") compareBoundValue(presentation.holderBinding.holderDid, session.holderDid, "Node holder binding is not bound to the session");
    compareBoundValue(presentation.nonce, challenge.nonce, "Node presentation nonce is not bound to the challenge");
    compareBoundValue(presentation.challengeId, challenge.challengeId, "Node presentation challenge is not bound");
    compareBoundValue(presentation.audience, challenge.audience, "Node presentation audience is not bound to the challenge");
    const sessionOrigin = session.targetOrigin ?? session.origin;
    if (sessionOrigin !== undefined && sessionOrigin !== envelope.origin) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node session origin is not bound to the share");
    if (session.spaceId !== undefined && session.spaceId !== envelope.spaceId) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node session space is not bound to the share");
    for (const key of ["shareCid", "shareId", "policyCid", "delegationCid", "authorityMaterialDigest", "sourceDigest", "targetOrigin", "nodeAudience", "resource", "action"] as const) {
      compareBoundValue(requestBinding[key], (session as Record<string, unknown>)[key], `Node session ${key} is not bound to the request`);
    }
    if (session.resource !== undefined) {
      if (typeof session.resource === "string") compareBoundValue(session.resource, envelope.resource.path, "Node session resource is not bound to the share");
      else {
        const value = this.requireObject(session.resource, "session resource");
        const path = typeof value.path === "string" ? value.path : value.value;
        compareBoundValue({ kind: value.kind, path }, envelope.resource, "Node session resource is not bound to the share");
      }
    }
    if (session.actions !== undefined) {
      if (!Array.isArray(session.actions)) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node session actions are invalid");
      const actions = session.actions.map((action) => action === "tinycloud.kv/get" || action === "get" ? "read" : action === "tinycloud.kv/list" || action === "list" ? "list" : action === "tinycloud.kv/put" || action === "tinycloud.kv/edit" || action === "put" || action === "edit" ? "edit" : action).sort();
      compareBoundValue(actions, envelope.actions, "Node session actions are not bound to the share");
    }
    const sessionExpiry = dateValue(session.expiresAt);
    const envelopeExpiry = dateValue(envelope.expiresAt);
    const presentationExpiry = dateValue(presentation.expiresAt);
    if (sessionExpiry === undefined || sessionExpiry <= this.now().getTime() || envelopeExpiry === undefined || sessionExpiry > envelopeExpiry || (presentationExpiry !== undefined && sessionExpiry > presentationExpiry)) throw new ShareAccessError("SHARE_SESSION_INVALID", "Node session expiry is invalid");
  }

  private assertAllowed(capability: { readonly spaceId: string; readonly resource: ShareResource; readonly actions: readonly ShareAction[] }, operation: "get" | "list" | "save", path: string): void {
    if (!shareCapabilityAllows(capability, operationAction(operation), path)) throw new ShareAccessError("SHARE_OUT_OF_SCOPE");
  }

  private async resolve(link: string): Promise<ResolvedArtifact> {
    const location = parseShareUrl(link, { trustedOrigins: this.options.trustedOrigins, maxInlineBytes: this.options.maxInlineBytes });
    if (location.protocol === "share-envelope-v2") return this.resolvePublished(link);
    let bytes: Uint8Array;
    if (location.kind === "inline") {
      bytes = new TextEncoder().encode(JSON.stringify(location.artifact));
    } else {
      if (location.cid === undefined) throw new ShareAccessError("SHARE_INVALID");
      const cached = this.cache.getByCid === undefined ? undefined : await this.cache.getByCid(location.cid, this.now());
      if (cached !== undefined) {
        if (!verifyShareCid(location.cid, cached.bytes)) {
          await this.cache.delete(cached.key);
          // A cache is an optimization, never an authority. Re-fetch the
          // canonical object once after evicting a corrupt entry.
          bytes = await this.fetchArtifact(location.origin, location.cid);
        } else {
          bytes = cached.bytes;
        }
      } else {
        bytes = await this.fetchArtifact(location.origin, location.cid);
      }
    }
    const artifact = location.artifact ?? parseShareArtifact(bytes, { expectedOrigin: location.origin, maxArtifactBytes: this.options.maxArtifactBytes, maxContentBytes: this.options.maxContentBytes });
    verifyShareEnvelope(artifact.envelope, { expectedOrigin: location.origin, maxContentBytes: this.options.maxContentBytes, now: this.now(), trustedSignerDids: this.options.trustedSignerDids });
    if (!artifact.envelope.encrypted && location.key !== undefined) throw new ShareAccessError("unsafe-plaintext");
    if (location.cid !== undefined && !verifyShareCid(location.cid, bytes)) {
      await this.cache.delete({ cid: location.cid, expiresAt: artifact.envelope.expiresAt });
      throw new ShareAccessError("SHARE_CID_MISMATCH");
    }
    if (location.cid !== undefined) await this.cache.set({ cid: location.cid, expiresAt: artifact.envelope.expiresAt }, bytes, { contentType: artifact.envelope.content.mimeType, size: artifact.envelope.content.size, encrypted: artifact.envelope.encrypted });
    const encodedContent = this.base64ToBytes(artifact.content);
    const plaintext = artifact.envelope.encrypted
      ? await decryptShareBytesAsync(encodedContent, location.key ?? (() => { throw new ShareAccessError("SHARE_KEY_REQUIRED"); })())
      : encodedContent;
    if (plaintext.byteLength > (this.options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES)) throw new ShareAccessError("SHARE_TOO_LARGE");
    return { location, artifact, bytes, plaintext };
  }

  private async fetchArtifact(origin: string, cid: string): Promise<Uint8Array> {
    const url = this.options.artifactUrl?.({ origin, cid }) ?? `${origin}/s/${cid}/raw`;
    const response = await this.fetchFn(url, { method: "GET", headers: { accept: "application/vnd.tinycloud.share-artifact+json, application/json" }, redirect: "error" });
    if (!response.ok) throw new ShareAccessError("SHARE_FETCH_FAILED");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > (this.options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES)) throw new ShareAccessError("SHARE_TOO_LARGE");
    if (!verifyShareCid(cid, bytes)) throw new ShareAccessError("SHARE_CID_MISMATCH");
    return bytes;
  }

  private async resolvePublished(link: string): Promise<ResolvedArtifact> {
    const published = parsePublishedShareLink(link, { trustedOrigins: this.options.trustedOrigins, maxInlineBytes: this.options.maxInlineBytes });
    let sealed = published.sealed;
    let cached: ShareCacheEntry | undefined;
    if (sealed === undefined && this.cache.getByCid !== undefined) {
      cached = await this.cache.getByCid(published.cid, this.now());
      if (cached !== undefined && verifyPublishedShareCid(published.cid, cached.bytes)) sealed = cached.bytes;
      else if (cached !== undefined) await this.cache.delete(cached.key);
    }
    if (sealed === undefined) {
      const url = this.options.artifactUrl?.({ origin: published.origin, cid: published.cid }) ?? `${published.origin}/s/${published.cid}/raw`;
      const response = await this.fetchFn(url, { method: "GET", headers: { accept: "application/vnd.tinycloud.share-envelope+json, application/json" }, redirect: "error" });
      if (!response.ok) throw new ShareAccessError("SHARE_FETCH_FAILED");
      sealed = new Uint8Array(await response.arrayBuffer());
    }
    if (sealed.byteLength > (this.options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES)) throw new ShareAccessError("SHARE_TOO_LARGE");
    if (!verifyPublishedShareCid(published.cid, sealed)) throw new ShareAccessError("SHARE_CID_MISMATCH");
    const envelopeBytes = published.key === undefined ? sealed : await openPublishedShareBlob(sealed, published.key);
    let plaintext = new Uint8Array();
    // Verify the signed envelope before following any content pointer. A
    // pointer is data, not authority, and must never create a pre-signature
    // fetch side channel.
    let preliminary: ReturnType<typeof parsePublishedShareEnvelope>;
    try {
      preliminary = parsePublishedShareEnvelope(envelopeBytes, { expectedOrigin: published.origin, now: this.now(), plaintext, trustedSignerDids: this.options.trustedSignerDids });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as { readonly code?: unknown }).code !== "invalid-envelope") throw error;
      const legacy = parseLegacyPublishedShareEnvelope(envelopeBytes, { expectedOrigin: published.origin, now: this.now(), plaintext, trustedSignerDids: this.options.trustedSignerDids });
      if (this.cache.getByCid !== undefined) await this.cache.set({ cid: published.cid, expiresAt: legacy.artifact.envelope.expiresAt }, sealed, { contentType: legacy.artifact.envelope.content.mimeType, size: sealed.byteLength, encrypted: true });
      const location: ShareLinkLocation = { kind: published.sealed === undefined ? "compact" : "inline", origin: published.origin, cid: published.cid, url: `${published.origin}/s/${published.cid}/raw`, protocol: "share-envelope-v2" };
      return { location, artifact: legacy.artifact, bytes: sealed, plaintext };
    }
    const pointer = preliminary.envelope.content;
    if (pointer !== undefined) {
      const contentUrl = this.options.artifactUrl?.({ origin: published.origin, cid: pointer.cid }) ?? `${published.origin}/s/${pointer.cid}/raw`;
      const contentResponse = await this.fetchFn(contentUrl, { method: "GET", headers: { accept: "application/octet-stream" }, redirect: "error" });
      if (!contentResponse.ok) throw new ShareAccessError("SHARE_FETCH_FAILED");
      const contentSealed = new Uint8Array(await contentResponse.arrayBuffer());
      if (contentSealed.byteLength > (this.options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES)) throw new ShareAccessError("SHARE_TOO_LARGE");
      if (!verifyPublishedShareCid(pointer.cid, contentSealed)) throw new ShareAccessError("SHARE_CID_MISMATCH");
      plaintext = new Uint8Array(await openPublishedShareBlob(contentSealed, this.base64ToBytes(pointer.key)));
    }
    const artifact = parsePublishedShareEnvelope(envelopeBytes, { expectedOrigin: published.origin, now: this.now(), plaintext, trustedSignerDids: this.options.trustedSignerDids }).artifact;
    if (this.cache.getByCid !== undefined) await this.cache.set({ cid: published.cid, expiresAt: artifact.envelope.expiresAt }, sealed, { contentType: artifact.envelope.content.mimeType, size: sealed.byteLength, encrypted: true });
    const location: ShareLinkLocation = { kind: published.sealed === undefined ? "compact" : "inline", origin: published.origin, cid: published.cid, url: `${published.origin}/s/${published.cid}/raw`, protocol: "share-envelope-v2" };
    return { location, artifact, bytes: sealed, plaintext };
  }

  private base64ToBytes(value: string): Uint8Array {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    if (typeof atob === "function") return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
    return new Uint8Array(Buffer.from(normalized, "base64"));
  }
}
