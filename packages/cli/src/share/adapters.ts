import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { ProfileManager } from "../config/profiles.js";
import {
  createRegisteredPolicyAuthority,
  publishAddressedShare,
  type SharePolicyAuthority,
  type ShareUploadAuthorization,
  type ShareUploadInput,
  type SenderShareRecord,
  type SenderShareRecordStorage,
  type ShareAuthorizationAdapter,
  type ShareAuthorizedContent,
  type TargetPublishAdapter,
  type ShareDeliveryAdapter,
  type ShareRevocationAdapter,
  type TargetPublishOutcome,
  type TargetPublishInput,
  type ShareAuthorizationResult,
  type ShareAuthorizationRequired,
  type LegacyShareReader,
} from "@tinycloud/share-sdk";
import { canonicalize, toBase64Url } from "@tinycloud/share-envelope";

const DEFAULT_SHARE_ORIGIN = "https://share.tinycloud.xyz";

interface SharePublicConfig {
  readonly shareOrigin: string;
  readonly registryOrigin: string;
  readonly nodeOrigin: string;
  readonly emailOrigin: string;
  readonly credentialsOrigin: string;
  readonly nodeAudience: string;
  readonly enforcerDid: string;
  readonly nodeInvitationKid: string;
  readonly nodeInvitationPublicKey: Uint8Array;
}

/**
 * The CLI process keeps its history encrypted even when no durable profile
 * store is available.  A later process can replace this adapter with the
 * profile vault without changing command semantics or exposing plaintext
 * records to the command layer.
 */
export function createEncryptedSessionHistory(): SenderShareRecordStorage {
  const records = new Map<string, Uint8Array>();
  let keyPromise: Promise<CryptoKey> | undefined;
  const key = async (): Promise<CryptoKey> => keyPromise ??= crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
  const encode = async (record: SenderShareRecord): Promise<Uint8Array> => {
    const secret = new TextEncoder().encode(JSON.stringify(record));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), secret));
    const value = new Uint8Array(iv.length + encrypted.length); value.set(iv); value.set(encrypted, iv.length); return value;
  };
  const decode = async (value: Uint8Array): Promise<SenderShareRecord> => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: value.slice(0, 12) }, await key(), value.slice(12)))) as SenderShareRecord;
  return {
    async put(record) {
      records.set(record.shareId, await encode(record));
    },
    async list() { return Promise.all([...records.values()].map(decode)); },
    async get(shareId) { const value = records.get(shareId); return value === undefined ? undefined : decode(value); },
    async delete(shareId) { records.delete(shareId); },
  };
}

export function createEncryptedProfileHistory(profileName: () => Promise<string>): SenderShareRecordStorage {
  const HISTORY_VERSION = 2;
  let profileSecretPromise: Promise<Uint8Array> | undefined;
  let operation = Promise.resolve();
  const profileSecret = async (): Promise<Uint8Array> => profileSecretPromise ??= (async () => {
    const profile = await profileName();
    const config = await ProfileManager.getProfile(profile);
    if (typeof config.privateKey === "string" && config.privateKey.length > 0) return new TextEncoder().encode(config.privateKey);
    // OpenKey profiles intentionally do not persist an Ethereum private key.
    // Their encrypted Share history is instead bound to the same private
    // session JWK used by the node SDK. Read it only in memory and never
    // include it in a record, error, or command result.
    const key = await ProfileManager.getKey(profile);
    const session = await ProfileManager.getSession(profile) as Record<string, unknown> | null;
    const jwk = session?.jwk && typeof session.jwk === "object" ? session.jwk : key;
    const privateParameter = jwk !== null && typeof jwk === "object" ? (jwk as Record<string, unknown>).d : undefined;
    if (typeof privateParameter !== "string" || privateParameter.length === 0) {
      throw new Error("share history requires an initialized profile");
    }
    const jwkRecord = jwk as Record<string, unknown>;
    const secret = { kty: jwkRecord.kty, crv: jwkRecord.crv, x: jwkRecord.x, d: privateParameter };
    return new TextEncoder().encode(JSON.stringify(secret));
  })();
  const path = async (): Promise<string> => join(await ProfileManager.getCacheDir(await profileName()), "share-history-v2.json");
  const legacyPath = async (): Promise<string> => join(await ProfileManager.getCacheDir(await profileName()), "share-history-v1.bin");
  const b64 = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
  const unb64 = (value: unknown): Uint8Array => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("share history is unavailable");
    const bytes = new Uint8Array(Buffer.from(value, "base64url"));
    if (b64(bytes) !== value) throw new Error("share history is unavailable");
    return bytes;
  };
  const derive = async (salt: Uint8Array, legacy = false): Promise<CryptoKey> => {
    const secret = await profileSecret();
    if (legacy) {
      const digest = await crypto.subtle.digest("SHA-256", secret);
      return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    }
    const material = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  };
  const read = async (): Promise<{ readonly values: SenderShareRecord[]; readonly salt: Uint8Array }> => {
    try {
      const encoded = new Uint8Array(await readFile(await path()));
      const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as Record<string, unknown>;
      if (envelope.version !== HISTORY_VERSION) throw new Error("share history is unavailable");
      const salt = unb64(envelope.kdfSalt);
      const iv = unb64(envelope.iv);
      const ciphertext = unb64(envelope.ciphertext);
      if (salt.length < 16 || iv.length !== 12 || ciphertext.length <= 16) throw new Error("share history is unavailable");
      const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await derive(salt), ciphertext);
      const values = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      return { values: Array.isArray(values) ? values.filter((value): value is SenderShareRecord => typeof value === "object" && value !== null && typeof (value as { shareId?: unknown }).shareId === "string") : [], salt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("share history is unavailable");
      try {
        const legacy = new Uint8Array(await readFile(await legacyPath()));
        if (legacy.length <= 12) return { values: [], salt: crypto.getRandomValues(new Uint8Array(16)) };
        const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: legacy.slice(0, 12) }, await derive(new Uint8Array(0), true), legacy.slice(12));
        const values = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
        return { values: Array.isArray(values) ? values.filter((value): value is SenderShareRecord => typeof value === "object" && value !== null && typeof (value as { shareId?: unknown }).shareId === "string") : [], salt: crypto.getRandomValues(new Uint8Array(16)) };
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return { values: [], salt: crypto.getRandomValues(new Uint8Array(16)) };
        throw new Error("share history is unavailable");
      }
    }
  };
  const write = async (values: readonly SenderShareRecord[], salt: Uint8Array): Promise<void> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new TextEncoder().encode(JSON.stringify(values));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await derive(salt), bytes));
    const output = new TextEncoder().encode(JSON.stringify({ version: HISTORY_VERSION, kdfSalt: b64(salt), iv: b64(iv), ciphertext: b64(encrypted) }));
    await writeFile(await path(), output, { mode: 0o600 });
  };
  const serial = <T>(operationFn: () => Promise<T>): Promise<T> => { const next = operation.then(operationFn, operationFn); operation = next.then(() => undefined, () => undefined); return next; };
  return {
    async put(record) { return serial(async () => { const state = await read(); const values = [...state.values]; const index = values.findIndex((value) => value.shareId === record.shareId); if (index >= 0) values[index] = record; else values.push(record); await write(values, state.salt); }); },
    async list() { return serial(async () => (await read()).values); },
    async get(shareId) { return serial(async () => (await read()).values.find((record) => record.shareId === shareId)); },
    async delete(shareId) { return serial(async () => { const state = await read(); await write(state.values.filter((record) => record.shareId !== shareId), state.salt); }); },
  };
}

/** Default noninteractive authority seams.  They return typed authorization
 * outcomes until an OpenKey/Node adapter is installed; commands never fall
 * through to an unconfigured legacy service or invent a successful result. */
export function createShareAuthorityAdapters(input: {
  readonly origin?: string;
  readonly nodeOrigin?: string;
  readonly emailOrigin?: string;
  readonly profileName?: () => Promise<string>;
  readonly fetchFn?: typeof globalThis.fetch;
  /** Injected in-process authority for tests or a host-specific deployment. */
  readonly publishTarget?: (value: TargetPublishInput) => Promise<TargetPublishOutcome>;
  readonly authorize?: ShareAuthorizationAdapter<ShareAuthorizedContent>;
  readonly deliver?: ShareDeliveryAdapter["deliver"];
  readonly revokeDelegation?: ShareRevocationAdapter["revokeDelegation"];
  readonly verifyResult?: NonNullable<ShareAuthorizationAdapter<ShareAuthorizedContent>["verifyResult"]>;
} = {}): {
  readonly targetAdapter: TargetPublishAdapter;
  readonly authorization: ShareAuthorizationAdapter<ShareAuthorizedContent>;
  readonly records: SenderShareRecordStorage;
  readonly delivery: ShareDeliveryAdapter;
  readonly revocation: ShareRevocationAdapter;
  readonly legacyReader: LegacyShareReader<Uint8Array>;
  readonly policyAuthority: SharePolicyAuthority;
} {
  const origin = input.origin ?? DEFAULT_SHARE_ORIGIN;
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const canonicalOrigin = (value: unknown, label: string): string => {
    if (typeof value !== "string") throw new Error(`share ${label} is unavailable`);
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) || parsed.origin !== value) throw new Error(`share ${label} is invalid`);
    return value;
  };
  let configPromise: Promise<SharePublicConfig> | undefined;
  const publicConfig = async (): Promise<SharePublicConfig> => configPromise ??= (async () => {
    const response = await fetchFn(`${origin}/.well-known/tinycloud-share/config.json`, {
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error("share public config is unavailable");
    const value = await response.json() as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("share public config is invalid");
    const object = value as Record<string, unknown>;
    const decodePublicKey = (key: unknown): Uint8Array => {
      if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("share node receipt key is invalid");
      const decoded = new Uint8Array(Buffer.from(key, "base64url"));
      if (decoded.length !== 32 || Buffer.from(decoded).toString("base64url") !== key) throw new Error("share node receipt key is invalid");
      return decoded;
    };
    const nodeOrigin = canonicalOrigin(input.nodeOrigin ?? object.nodeOrigin, "node origin");
    const nodeAudience = typeof object.nodeAudience === "string" ? object.nodeAudience : "";
    const enforcerDid = typeof object.enforcerDid === "string" ? object.enforcerDid : nodeAudience;
    const nodeInvitationKid = typeof object.nodeInvitationKid === "string" ? object.nodeInvitationKid : "";
    if (!nodeAudience.startsWith("did:web:") || !nodeInvitationKid.startsWith(`${nodeAudience}#`) || (!enforcerDid.startsWith("did:key:") && enforcerDid !== nodeAudience)) throw new Error("share node trust binding is invalid");
    return {
      shareOrigin: canonicalOrigin(object.shareOrigin, "origin"),
      registryOrigin: canonicalOrigin(object.registryOrigin, "registry origin"),
      nodeOrigin,
      emailOrigin: canonicalOrigin(input.emailOrigin ?? object.emailOrigin, "email origin"),
      credentialsOrigin: canonicalOrigin(object.credentialsOrigin, "credentials origin"),
      nodeAudience,
      enforcerDid,
      nodeInvitationKid,
      nodeInvitationPublicKey: decodePublicKey(object.nodeInvitationPublicKey),
    };
  })();
  let nodePromise: Promise<Awaited<ReturnType<typeof import("../lib/sdk.js")["ensureAuthenticated"]>>> | undefined;
  const authenticatedNode = async () => nodePromise ??= (async () => {
    const config = await publicConfig();
    const profile = await (input.profileName?.() ?? selectedProfileName());
    const context = await ProfileManager.resolveContext({ profile, host: config.nodeOrigin });
    const { ensureAuthenticated } = await import("../lib/sdk.js");
    return ensureAuthenticated(context);
  })();
  const endpoint = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    return endpointAt(origin, path, body);
  };
  const endpointAt = async (requestOrigin: string, path: string, body: unknown): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchFn(`${requestOrigin}${path}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", origin: requestOrigin }, body: JSON.stringify(body), credentials: "include", redirect: "error", referrerPolicy: "no-referrer" });
    } catch { throw new Error("share authority is unavailable"); }
    if (!response.ok) throw new Error("share authority rejected the request");
    const value = await response.json() as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("share authority returned an invalid response");
    return value as Record<string, unknown>;
  };
  const decodeBytes = (value: unknown): Uint8Array => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("share authority returned invalid binary data");
    return new Uint8Array(Buffer.from(value, "base64url"));
  };
  const exactObject = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("share authority returned an invalid object");
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) throw new Error("share authority returned an unexpected response");
    return object;
  };
  const parseAuthorizationRequired = (value: Record<string, unknown>): ShareAuthorizationRequired => {
    const keys = Object.keys(value);
    if (value.state !== "authorization-required" || (keys.some((key) => !["state", "method", "continueUrl", "resumeToken"].includes(key)))) throw new Error("share authority returned an invalid authorization step");
    if (value.method !== "openkey-device" && value.method !== "email-claim" && value.method !== "email-otp") throw new Error("share authority returned an invalid authorization method");
    if (value.continueUrl !== undefined && typeof value.continueUrl !== "string") throw new Error("share authority returned an invalid continuation");
    if (value.resumeToken !== undefined && (typeof value.resumeToken !== "string" || value.resumeToken.length < 16 || value.resumeToken.length > 512)) throw new Error("share authority returned an invalid resume token");
    return { state: "authorization-required", method: value.method, ...(value.continueUrl === undefined ? {} : { continueUrl: value.continueUrl }), ...(value.resumeToken === undefined ? {} : { resumeToken: value.resumeToken }) };
  };
  const parseAuthorization = (value: Record<string, unknown>): ShareAuthorizationResult<ShareAuthorizedContent> => {
    if (value.state === "authorization-required") {
      return parseAuthorizationRequired(value);
    }
    if (value.state === "denied") {
      exactObject(value, ["state", "reason"]);
      if (value.reason !== "rejected" && value.reason !== "expired" && value.reason !== "revoked" && value.reason !== "unsupported") throw new Error("share authority returned an invalid denial");
      return { state: "denied", reason: value.reason };
    }
    if (value.state !== "ready" || typeof value.value !== "object" || value.value === null || Array.isArray(value.value)) throw new Error("share authority returned an invalid authorization result");
    const raw = value.value as Record<string, unknown>;
    exactObject(value, ["state", "value"]);
    exactObject(raw, ["bytes", "bodyDigest", "contentSourceDigest", "binding", "proof"]);
    const binding = exactObject(raw.binding, ["shareId", "delegationCid", "authorityMaterialHandle", "authorityMaterialDigest", "resource", "action"]);
    const resource = exactObject(binding.resource, ["kind", "path"]);
    if ((resource.kind !== "exact" && resource.kind !== "prefix") || typeof resource.path !== "string") throw new Error("share authority returned an invalid resource binding");
    const bytes = raw.bytes instanceof Uint8Array ? raw.bytes : decodeBytes(raw.bytes ?? raw.content);
    if (typeof raw.bodyDigest !== "string" || typeof raw.contentSourceDigest !== "string" || typeof raw.proof !== "object" || raw.proof === null || typeof binding.shareId !== "string" || typeof binding.delegationCid !== "string" || typeof binding.authorityMaterialHandle !== "string" || typeof binding.authorityMaterialDigest !== "string") throw new Error("share authority returned an incomplete authorization result");
    return { state: "ready", value: { bytes, bodyDigest: raw.bodyDigest, contentSourceDigest: raw.contentSourceDigest, binding: { shareId: binding.shareId, delegationCid: binding.delegationCid, authorityMaterialHandle: binding.authorityMaterialHandle, authorityMaterialDigest: binding.authorityMaterialDigest, resource: { kind: resource.kind as "exact" | "prefix", path: resource.path }, ...(binding.action === undefined ? {} : { action: String(binding.action) }) }, proof: raw.proof } };
  };
  const verifyProductionAuthorizationResult: NonNullable<ShareAuthorizationAdapter<ShareAuthorizedContent>["verifyResult"]> = async ({ value, proof }) => {
    try {
      const config = await publicConfig();
      if (typeof proof !== "object" || proof === null || Array.isArray(proof)) return false;
      const detached = proof as Record<string, unknown>;
      if (detached.alg !== "EdDSA" || detached.kid !== config.nodeInvitationKid || typeof detached.signature !== "string") return false;
      const signature = new Uint8Array(Buffer.from(detached.signature, "base64url"));
      if (signature.length !== 64 || toBase64Url(signature) !== detached.signature) return false;
      const body = { ...value } as Record<string, unknown>;
      delete body.proof;
      const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from([...config.nodeInvitationPublicKey])]);
      return verifySignature(null, Buffer.from(`xyz.tinycloud.share/read-response/v2\0${canonicalize(body)}`), createPublicKey({ key: spki, format: "der", type: "spki" }), signature);
    } catch { return false; }
  };
  const addressedChallenge = async (envelope: import("@tinycloud/share-envelope").ShareEnvelopeV2, holderDid: string): Promise<Record<string, unknown>> => {
    const authority = envelope.ownerAuthority;
    if (authority === undefined) throw new Error("share authority returned an unsupported addressed envelope");
    const outer = authority.outerEnvelope as Record<string, unknown>;
    const target = outer.target as Record<string, unknown>;
    const resource = outer.resource as Record<string, unknown>;
    const source = outer.contentSource as Record<string, unknown>;
    const enforcement = authority.enforcementDelegation as Record<string, unknown>;
    const actions = [...new Set(envelope.actions.map((action) => action === "read" ? "tinycloud.kv/get" : action === "list" ? "tinycloud.kv/list" : "tinycloud.kv/put"))].sort();
    const body = {
      envelopeCid: authority.envelopeCid,
      shareCid: authority.shareCid,
      shareId: envelope.shareId,
      registrationCid: authority.registrationCid,
      delegationCid: envelope.delegationCid,
      policyCid: envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "",
      enforcementDelegationCid: String(enforcement.cid),
      enforcementDelegation: enforcement,
      outerEnvelope: outer,
      contentSource: source,
      contentSourceDigest: String(outer.contentSourceDigest),
      holderDid,
      targetOrigin: String(target.origin),
      nodeAudience: String(target.nodeAudience),
      action: actions.includes("tinycloud.kv/list") ? "tinycloud.kv/list" : actions.includes("tinycloud.kv/put") ? "tinycloud.kv/put" : "tinycloud.kv/get",
      actions,
      resource: String(resource.path),
    };
    const requestBodyDigest = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(body)))));
    return { ...body, requestBodyDigest };
  };
  const targetAdapter: TargetPublishAdapter = { async publish(targetInput) {
    if (input.publishTarget !== undefined) return input.publishTarget(targetInput);
    const [config, node] = await Promise.all([publicConfig(), authenticatedNode()]);
    if (targetInput.origin !== config.shareOrigin || node.spaceId === undefined) throw new Error("addressed publication is not bound to the configured Share service");
    const shareId = crypto.randomUUID().replaceAll("-", "");
    const files = targetInput.files === undefined || targetInput.files.length === 0
      ? [{ bytes: targetInput.source, filename: targetInput.filename, mediaType: targetInput.mediaType }]
      : targetInput.files;
    const resourceKind = targetInput.resourceKind ?? (files.length > 1 ? "prefix" : "exact");
    const resourcePath = `shares/${shareId}${resourceKind === "exact" ? `/${targetInput.filename}` : ""}`;
    const kv = node.kvForSpace(node.spaceId);
    for (const file of files) {
      const path = resourceKind === "prefix" ? `${resourcePath}/${file.filename}` : resourcePath;
      const stored = await kv.put(path, file.bytes, { contentType: file.mediaType ?? "application/octet-stream" });
      if (!stored.ok) throw new Error("addressed source upload was rejected");
    }
    const actions = targetInput.actions === undefined || targetInput.actions.length === 0 ? ["read"] as const : targetInput.actions;
    const policyActions = [...new Set(actions.flatMap((action) => action === "read" ? ["tinycloud.kv/get", "tinycloud.kv/metadata"] : action === "list" ? ["tinycloud.kv/list"] : ["tinycloud.kv/put"]))];
    return publishAddressedShare({
      shareId,
      shareOrigin: config.shareOrigin,
      nodeOrigin: config.nodeOrigin,
      nodeAudience: config.nodeAudience,
      enforcerDid: config.enforcerDid,
      spaceId: node.spaceId,
      target: targetInput.target,
      resource: { kind: resourceKind, path: resourcePath },
      actions,
      policyActions,
      contentSource: { kind: "kv", space: node.spaceId, path: resourcePath, action: "tinycloud.kv/get" },
      filename: targetInput.filename,
      mediaType,
      byteLength: files.reduce((total, file) => total + file.bytes.byteLength, 0),
      expiresAt: targetInput.expiresAt,
      inline: targetInput.inline,
      authority: {
        ownerDid: node.did,
        createOwnerDelegation: (request) => node.createOwnerDelegation(request),
        registerOwnerSharePolicy: (request) => node.registerOwnerSharePolicy({
          ...(request as Parameters<typeof node.registerOwnerSharePolicy>[0]),
          nodeProof: { kid: config.nodeInvitationKid, publicKey: config.nodeInvitationPublicKey },
        }),
      },
      upload: targetInput.upload ?? {},
    });
  } };
  const authorization: ShareAuthorizationAdapter<ShareAuthorizedContent> = input.authorize ?? {
    async begin(request) {
      const node = await authenticatedNode();
      const value = await endpointAt((await publicConfig()).nodeOrigin, "/share/v2/policy/challenges", await addressedChallenge(request.envelope, node.did));
      if (value.challenge !== undefined && typeof value.challenge === "object" && value.challenge !== null && !Array.isArray(value.challenge)) {
        const challenge = value.challenge as Record<string, unknown>;
        if (typeof challenge.challengeId !== "string") throw new Error("share authority returned an invalid challenge");
        return { state: "authorization-required", method: request.method, resumeToken: challenge.challengeId };
      }
      return parseAuthorization(value);
    },
    async resume(request) {
      const config = await publicConfig();
      const proof = request.proof;
      const body = typeof proof === "object" && proof !== null && !Array.isArray(proof) ? { ...(proof as Record<string, unknown>), challengeId: request.resumeToken } : { challengeId: request.resumeToken, proof };
      const value = await endpointAt(config.nodeOrigin, "/share/v2/policy/session", body);
      return parseAuthorization(value);
    },
    verifyResult: input.verifyResult ?? verifyProductionAuthorizationResult,
  };
  const delivery: ShareDeliveryAdapter = { deliver: input.deliver ?? (async (request) => {
    const record = request.record;
    if (
      record === undefined
      || record.link === undefined
      || record.envelopeCid === undefined
      || record.shareCid === undefined
      || record.registrationCid === undefined
      || record.policyCid === undefined
      || record.ownerDelegationCid === undefined
      || record.enforcementDelegationCid === undefined
    ) throw new Error("share delivery history is incomplete");
    const [config, node] = await Promise.all([publicConfig(), authenticatedNode()]);
    const receipt = await node.authorizeShareDelivery({
      envelopeCid: record.envelopeCid,
      shareCid: record.shareCid,
      shareId: record.shareId,
      registrationCid: record.registrationCid,
      policyCid: record.policyCid,
      delegationCid: record.ownerDelegationCid,
      enforcementDelegationCid: record.enforcementDelegationCid,
      resourcePath: record.resource.path,
      recipientEmail: request.recipient,
      shareUrl: record.link,
      documentName: record.filename ?? "share.md",
      expiresAt: new Date(Math.min(Date.parse(record.expiresAt), Date.now() + 5 * 60 * 1000)).toISOString(),
      nodeProof: { kid: config.nodeInvitationKid, publicKey: config.nodeInvitationPublicKey },
      credentialsAudience: config.credentialsOrigin,
    });
    const response = await fetchFn(`${config.emailOrigin}/share/v2`, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": request.idempotencyKey ?? `tinycloud-share:${record.shareId}` },
      body: JSON.stringify({ authorization: receipt.authorization, proof: receipt.proof, shareUrl: record.link }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error("share delivery was not accepted");
    return response.status === 208 ? "already-delivered" : "delivered";
  }) };
  const revocation: ShareRevocationAdapter = { revokeDelegation: input.revokeDelegation ?? (async (request) => {
    const result = await (await authenticatedNode()).revokeDelegation(request.delegationCid);
    if (!result.ok) throw new Error("share delegation revocation was rejected");
  }) };
  const legacyReader: LegacyShareReader<Uint8Array> = {
    async read(link) {
      // This is deliberately an explicit, read-only bridge. Modern publish
      // never enters the legacy SDK and the raw tc1 material never crosses
      // the command result boundary.
      const { TinyCloudNode } = await import("@tinycloud/node-sdk");
      const node = new TinyCloudNode({ host: (await publicConfig()).nodeOrigin, autoDiscoverLocalNode: false });
      const received = await node.sharing.receive(link, { autoSubdelegate: false, useSessionKey: false });
      if (!received.ok) throw new Error("legacy share could not be verified");
      const value = await received.data.kv.get<Uint8Array>(received.data.path, { binary: true });
      if (!value.ok || !(value.data.data instanceof Uint8Array)) throw new Error("legacy share content could not be read");
      return value.data.data.slice();
    },
  };
  const policyAuthority: SharePolicyAuthority = {
    async resolve(request) {
      const config = await publicConfig();
      return createRegisteredPolicyAuthority({
        nodeProof: { kid: config.nodeInvitationKid, publicKey: config.nodeInvitationPublicKey },
        expectedTarget: { origin: config.nodeOrigin, nodeAudience: config.nodeAudience, enforcerDid: config.enforcerDid },
      }).resolve(request);
    },
  };
  return {
    targetAdapter,
    authorization,
    records: input.profileName === undefined ? createEncryptedSessionHistory() : createEncryptedProfileHistory(input.profileName),
    delivery,
    revocation,
    legacyReader,
    policyAuthority,
  };
}

function authenticationMessage(origin: string, address: string, nonce: string, issuedAt: string): string {
  return [
    `${new URL(origin).host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to TinyCloud Share.",
    "",
    `URI: ${origin}`,
    "Version: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

function cookieFromResponse(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  const raw = values[0] ?? response.headers.get("set-cookie") ?? undefined;
  return raw?.split(";", 1)[0];
}

async function selectedProfileName(): Promise<string> {
  const config = await ProfileManager.getConfig();
  return process.env.TC_PROFILE ?? config.defaultProfile;
}

async function profilePrivateKeyFor(profileName: string): Promise<string> {
  const profile = await ProfileManager.getProfile(profileName);
  if (typeof profile.privateKey !== "string" || profile.privateKey.length === 0) {
    throw new Error("share upload requires an authorized wallet or OpenKey device profile");
  }
  return profile.privateKey;
}

async function profileShareSessionAuthorization(profileName: string): Promise<ShareUploadAuthorization | undefined> {
  const session = await ProfileManager.getSession(profileName) as Record<string, unknown> | null;
  const cookie = session?.shareSessionCookie ?? session?.shareCookie;
  if (typeof cookie !== "string" || !/^share_session=[A-Za-z0-9_-]{32,}$/.test(cookie)) return undefined;
  return { cookie };
}

async function establishOpenKeyShareSession(profileName: string, origin: string, fetchFn: typeof globalThis.fetch): Promise<ShareUploadAuthorization> {
  const profile = await ProfileManager.getProfile(profileName);
  if (profile.authMethod !== "openkey") throw new Error("share upload requires an authorized profile");
  const { OpenKey } = await import("@openkey/sdk");
  const openkey = new OpenKey({ host: profile.openkeyHost ?? "https://openkey.so", appName: "TinyCloud CLI", mode: "popup" });
  const auth = await openkey.connect();
  const nonceResponse = await fetchFn(`${origin}/api/share/auth/openkey/nonce`, { headers: { accept: "application/json", origin }, credentials: "include", redirect: "error", referrerPolicy: "no-referrer" });
  if (!nonceResponse.ok) throw new Error("share sign-in nonce was rejected");
  const nonceBody = await nonceResponse.json() as { readonly nonce?: unknown; readonly expiresAt?: unknown };
  if (typeof nonceBody.nonce !== "string" || typeof nonceBody.expiresAt !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(nonceBody.nonce)) throw new Error("share sign-in challenge is invalid");
  const issuedAt = new Date().toISOString();
  const message = authenticationMessage(origin, auth.address, nonceBody.nonce, issuedAt);
  const signed = await openkey.signMessage({ message, keyId: auth.keyId });
  if (signed.address.toLowerCase() !== auth.address.toLowerCase()) throw new Error("share sign-in address mismatch");
  const authenticated = await fetchFn(`${origin}/api/share/auth/openkey`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", origin }, credentials: "include", body: JSON.stringify({ address: auth.address, signature: signed.signature, message, nonce: nonceBody.nonce, issuedAt }), redirect: "error", referrerPolicy: "no-referrer" });
  const cookie = cookieFromResponse(authenticated);
  if (!authenticated.ok || cookie === undefined) throw new Error("share sign-in was rejected");
  return { cookie };
}

/**
 * Establishes the same nonce-bound Share session used by the browser and
 * returns only the upload request headers. Private wallet material and the
 * session cookie never cross this adapter's boundary or enter SDK results.
 */
export function createProductionUploadAuthorizer(input: {
  readonly origin?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly privateKey?: () => Promise<string>;
  /** A host-issued Share session for OpenKey profiles; never derive upload authority from a session JWK. */
  readonly sessionAuthorization?: () => Promise<ShareUploadAuthorization | undefined>;
  /** Resolved by the command adapter so --profile always wins over defaults. */
  readonly profileName?: () => Promise<string>;
} = {}): (upload: ShareUploadInput) => Promise<ShareUploadAuthorization> {
  const origin = input.origin ?? DEFAULT_SHARE_ORIGIN;
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  let sessionCookie: string | undefined;
  let sessionExpiresAt = 0;
  return async (_upload) => {
    if (sessionCookie !== undefined && sessionExpiresAt > Date.now() + 30_000) return { cookie: sessionCookie };
    const profileName = await (input.profileName?.() ?? selectedProfileName());
    const profile = await ProfileManager.getProfile(profileName);
    const suppliedSession = input.sessionAuthorization === undefined
      ? undefined
      : await input.sessionAuthorization();
    const storedSession = suppliedSession ?? await profileShareSessionAuthorization(profileName);
    const sessionAuthorization = storedSession ?? (profile.authMethod === "openkey"
      ? await establishOpenKeyShareSession(profileName, origin, fetchFn)
      : undefined);
    if (sessionAuthorization !== undefined) return sessionAuthorization;
    const key = await (input.privateKey?.() ?? profilePrivateKeyFor(profileName));
    // Keep public inspect/receive independent from the legacy Node SDK graph.
    // Authentication is loaded only after a publish selects its auth path.
    const { PrivateKeySigner } = await import("@tinycloud/node-sdk");
    const signer = new PrivateKeySigner(key);
    const address = await signer.getAddress();
    const nonceResponse = await fetchFn(`${origin}/api/share/auth/openkey/nonce`, {
      headers: { accept: "application/json", origin },
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!nonceResponse.ok) throw new Error("share sign-in nonce was rejected");
    const nonceBody = await nonceResponse.json() as { readonly nonce?: unknown; readonly expiresAt?: unknown };
    if (typeof nonceBody.nonce !== "string" || typeof nonceBody.expiresAt !== "string") throw new Error("share sign-in challenge is invalid");
    const issuedAt = new Date().toISOString();
    const message = authenticationMessage(origin, address, nonceBody.nonce, issuedAt);
    const signature = await signer.signMessage(message);
    const authenticated = await fetchFn(`${origin}/api/share/auth/openkey`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", origin },
      body: JSON.stringify({ address, signature, message, nonce: nonceBody.nonce, issuedAt }),
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const cookie = cookieFromResponse(authenticated);
    if (!authenticated.ok || cookie === undefined) throw new Error("share sign-in was rejected");
    sessionCookie = cookie;
    sessionExpiresAt = Date.now() + 15 * 60_000;
    return { cookie };
  };
}
