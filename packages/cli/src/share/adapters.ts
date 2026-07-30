import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfileManager } from "../config/profiles.js";
import type { ShareUploadAuthorization, ShareUploadInput, SenderShareRecord, SenderShareRecordStorage, ShareAuthorizationAdapter, ShareAuthorizedContent, TargetPublishAdapter, ShareDeliveryAdapter, ShareRevocationAdapter, TargetPublishOutcome, TargetPublishInput, ShareAuthorizationResult, ShareAuthorizationRequired, PublishedShare, LegacyShareReader } from "@tinycloud/share-sdk";

const DEFAULT_SHARE_ORIGIN = "https://share.tinycloud.xyz";

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
  let privateKeyPromise: Promise<Uint8Array> | undefined;
  let operation = Promise.resolve();
  const privateKey = async (): Promise<Uint8Array> => privateKeyPromise ??= (async () => {
    const profile = await profileName();
    const config = await ProfileManager.getProfile(profile);
    if (typeof config.privateKey !== "string" || config.privateKey.length === 0) throw new Error("share history requires an initialized profile");
    return new TextEncoder().encode(config.privateKey);
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
    const secret = await privateKey();
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
} {
  const origin = input.origin ?? DEFAULT_SHARE_ORIGIN;
  const nodeOrigin = input.nodeOrigin ?? origin;
  const emailOrigin = input.emailOrigin ?? origin;
  const fetchFn = input.fetchFn ?? globalThis.fetch;
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
  const parsePublishedShare = (value: Record<string, unknown>): PublishedShare => {
    exactObject(value, ["protocol", "version", "url", "link", "metadata", "registryDeleteAfter"]);
    if (value.protocol !== "tinycloud-share" || value.version !== 1 || typeof value.url !== "string" || value.url.length === 0 || typeof value.registryDeleteAfter !== "string") throw new Error("share authority returned an invalid publication");
    const link = exactObject(value.link, ["kind", "cid"]);
    if (link.kind !== "compact" && link.kind !== "inline") throw new Error("share authority returned an invalid link");
    const metadata = exactObject(value.metadata, ["protocol", "version", "shareId", "origin", "target", "resource", "actions", "expiresAt", "display", "content", "recipientMatcher", "registrationCid", "policyCid", "ownerDelegationCid", "enforcementDelegationCid", "ownerDid", "shareKeyDid", "enforcerDid"]);
    const target = exactObject(metadata.target, ["kind", "origin", "nodeAudience", "spaceId"]);
    if (!["bearer", "recipientDid", "email", "emailDomain"].includes(String(target.kind)) || typeof target.origin !== "string" || typeof target.nodeAudience !== "string" || typeof target.spaceId !== "string") throw new Error("share authority returned an invalid target");
    const resource = exactObject(metadata.resource, ["kind", "path"]);
    if ((resource.kind !== "exact" && resource.kind !== "prefix") || typeof resource.path !== "string" || !Array.isArray(metadata.actions) || !metadata.actions.every((action) => typeof action === "string") || typeof metadata.shareId !== "string" || typeof metadata.origin !== "string" || typeof metadata.expiresAt !== "string") throw new Error("share authority returned invalid metadata");
    const display = exactObject(metadata.display, ["filename", "senderName"]);
    if (display.filename !== undefined && typeof display.filename !== "string") throw new Error("share authority returned invalid display metadata");
    if (display.senderName !== undefined && typeof display.senderName !== "string") throw new Error("share authority returned invalid display metadata");
    const content = metadata.content === undefined ? undefined : exactObject(metadata.content, ["cid"]);
    if (content !== undefined && typeof content.cid !== "string") throw new Error("share authority returned invalid content metadata");
    const matcher = metadata.recipientMatcher === undefined ? undefined : exactObject(metadata.recipientMatcher, ["kind", "value"]);
    if (matcher !== undefined && !["bearer", "recipientDid", "exactEmail", "emailDomain"].includes(String(matcher.kind))) throw new Error("share authority returned invalid recipient metadata");
    return {
      protocol: "tinycloud-share", version: 1, url: value.url,
      link: { kind: link.kind, cid: String(link.cid) },
      metadata: {
        protocol: "tinycloud-share", version: 1, shareId: String(metadata.shareId), origin: String(metadata.origin),
        target: { kind: target.kind as "bearer" | "recipientDid" | "email" | "emailDomain", origin: String(target.origin), nodeAudience: String(target.nodeAudience), spaceId: String(target.spaceId) },
        resource: { kind: resource.kind as "exact" | "prefix", path: String(resource.path) }, actions: metadata.actions as string[], expiresAt: String(metadata.expiresAt),
        display: { ...(display.filename === undefined ? {} : { filename: display.filename }), ...(display.senderName === undefined ? {} : { senderName: display.senderName }) },
        ...(content === undefined ? {} : { content: { cid: String(content.cid) } }),
        ...(matcher === undefined ? {} : { recipientMatcher: { kind: matcher.kind as "bearer" | "recipientDid" | "exactEmail" | "emailDomain", ...(matcher.value === undefined ? {} : { value: String(matcher.value) }) } }),
        ...Object.fromEntries(["registrationCid", "policyCid", "ownerDelegationCid", "enforcementDelegationCid", "ownerDid", "shareKeyDid", "enforcerDid"].filter((key) => typeof metadata[key] === "string").map((key) => [key, metadata[key]])),
      },
      registryDeleteAfter: value.registryDeleteAfter,
    };
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
  const targetAdapter: TargetPublishAdapter = { async publish(targetInput) {
    if (input.publishTarget !== undefined) return input.publishTarget(targetInput);
    const value = await endpoint("/share/v2/policies", { policy: { source: Buffer.from(targetInput.source).toString("base64url"), filename: targetInput.filename, target: targetInput.target, expiresAt: targetInput.expiresAt.toISOString(), origin: targetInput.origin }, notify: targetInput.notify ?? false });
    if (value.state === "authorization-required") return parseAuthorizationRequired(value);
    return parsePublishedShare(value);
  } };
  const authorization: ShareAuthorizationAdapter<ShareAuthorizedContent> = input.authorize ?? {
    async begin(request) {
      const value = await endpoint("/share/v2/policy/challenges", { envelope: request.envelope, method: request.method });
      return parseAuthorization(value);
    },
    async resume(request) {
      const value = await endpoint("/share/v2/policy/session", { envelope: request.envelope, method: request.method, resumeToken: request.resumeToken, proof: request.proof });
      return parseAuthorization(value);
    },
    ...(input.verifyResult === undefined ? {} : { verifyResult: input.verifyResult }),
  };
  const delivery: ShareDeliveryAdapter = { deliver: input.deliver ?? (async (request) => {
    // OpenCredentials is the delivery authority. The Share/Node surface only
    // authorizes the invitation; it does not expose a Share-local notify
    // route. Keep this request on the implemented credentials path and fail
    // closed unless the authority returns its exact accepted contract.
    const value = await endpointAt(emailOrigin, "/v1/share-email/invitations", request);
    if (value.status !== "accepted") throw new Error("share delivery was not accepted");
    return "delivered";
  }) };
  const revocation: ShareRevocationAdapter = { revokeDelegation: input.revokeDelegation ?? (async (request) => { await endpointAt(nodeOrigin, "/revoke", request); }) };
  const legacyReader: LegacyShareReader<Uint8Array> = {
    async read(link) {
      // This is deliberately an explicit, read-only bridge. Modern publish
      // never enters the legacy SDK and the raw tc1 material never crosses
      // the command result boundary.
      const { TinyCloudNode } = await import("@tinycloud/node-sdk");
      const node = new TinyCloudNode({ host: origin, autoDiscoverLocalNode: false });
      const received = await node.sharing.receive(link, { autoSubdelegate: false, useSessionKey: false });
      if (!received.ok) throw new Error("legacy share could not be verified");
      const value = await received.data.kv.get<Uint8Array>(received.data.path, { binary: true });
      if (!value.ok || !(value.data.data instanceof Uint8Array)) throw new Error("legacy share content could not be read");
      return value.data.data.slice();
    },
  };
  return {
    targetAdapter,
    authorization,
    records: input.profileName === undefined ? createEncryptedSessionHistory() : createEncryptedProfileHistory(input.profileName),
    delivery,
    revocation,
    legacyReader,
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

/**
 * Establishes the same nonce-bound Share session used by the browser and
 * returns only the upload request headers. Private wallet material and the
 * session cookie never cross this adapter's boundary or enter SDK results.
 */
export function createProductionUploadAuthorizer(input: {
  readonly origin?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly privateKey?: () => Promise<string>;
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
