import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ProfileManager } from "../config/profiles.js";
import {
  createRegisteredPolicyAuthority,
  createAddressedAuthorization,
  createShareV2HolderBindingArtifact,
  SHARE_V2_PROTOCOL,
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
  type LegacyShareReader,
} from "@tinycloud/share-sdk";
import { canonicalize, fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import { activateSessionWithHost } from "@tinycloud/sdk-core";

const DEFAULT_SHARE_ORIGIN = "https://share.tinycloud.xyz";

export class ShareAuthorityError extends Error {
  readonly code: "AUTH_REQUIRED" | "UNAVAILABLE";
  constructor(code: "AUTH_REQUIRED" | "UNAVAILABLE", message: string) {
    super(message);
    this.name = "ShareAuthorityError";
    this.code = code;
  }
}

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

export async function postAddressedShareDelivery(input: {
  readonly credentialsOrigin: string;
  readonly receipt: { readonly authorization: unknown; readonly proof: unknown };
  readonly shareUrl: string;
  readonly fetchFn: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<Response> {
  return input.fetchFn(`${input.credentialsOrigin}/share/v2`, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      authorization: input.receipt.authorization,
      proof: input.receipt.proof,
      shareUrl: input.shareUrl,
    }),
    signal: input.signal,
  });
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

export function createEncryptedProfileHistory(profileName: () => Promise<string>, sessionSigner?: (bytes: Uint8Array) => Promise<Uint8Array>): SenderShareRecordStorage {
  const HISTORY_VERSION = 2;
  let profileSecretPromise: Promise<Uint8Array> | undefined;
  let operation = Promise.resolve();
  const profileSecret = async (): Promise<Uint8Array> => profileSecretPromise ??= (async () => {
    const profile = await profileName();
    const config = await ProfileManager.getProfile(profile);
    if (typeof config.privateKey === "string" && config.privateKey.length > 0) return new TextEncoder().encode(config.privateKey);
    // OpenKey profiles bind history to a signature from the established
    // session interface. The private session key never enters this adapter.
    if (sessionSigner === undefined) {
      throw new Error("share history requires an initialized profile");
    }
    return sessionSigner(new TextEncoder().encode("xyz.tinycloud.share/history-key/v1"));
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
    const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > 100 * 1024 * 1024) throw new Error("addressed publication exceeds the combined byte limit");
    const kv = node.kvForSpace(node.spaceId);
    for (const file of files) {
      const path = resourceKind === "prefix" ? `${resourcePath}/${file.filename}` : resourcePath;
      const stored = await kv.put(path, file.bytes, { contentType: file.mediaType ?? "application/octet-stream" });
      if (!stored.ok) throw new Error("addressed source upload was rejected");
    }
    const actions = targetInput.actions === undefined || targetInput.actions.length === 0 ? ["read"] as const : targetInput.actions;
    const policyActions = [...new Set(actions.flatMap((action) => action === "read" ? ["tinycloud.kv/get", "tinycloud.kv/metadata"] : action === "list" ? ["tinycloud.kv/list"] : ["tinycloud.kv/put"]))] as ("tinycloud.kv/get" | "tinycloud.kv/list" | "tinycloud.kv/metadata" | "tinycloud.kv/put")[];
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
      mediaType: targetInput.mediaType ?? files[0]?.mediaType ?? "application/octet-stream",
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
  const canonicalAuthorization = async (): Promise<ShareAuthorizationAdapter<ShareAuthorizedContent>> => {
    const [config, profileName] = await Promise.all([publicConfig(), input.profileName?.() ?? selectedProfileName()]);
    const profile = await ProfileManager.getProfile(profileName).catch(() => {
      throw new ShareAuthorityError("AUTH_REQUIRED", "share recipient authorization requires an initialized profile");
    });
    const session = await ProfileManager.getSession(profileName) as Record<string, unknown> | null;
    const node = await authenticatedNode();
    const holderDid = node.sessionDid;
    if (profile.authMethod !== "openkey" || session === null || typeof holderDid !== "string" || !holderDid.startsWith("did:key:")) {
      throw new ShareAuthorityError("AUTH_REQUIRED", "share recipient authorization requires an active OpenKey session");
    }
    const delegationHeader = session.delegationHeader;
    const credential = typeof delegationHeader === "object" && delegationHeader !== null
      ? (delegationHeader as Record<string, unknown>).Authorization
      : undefined;
    const delegationCid = session.delegationCid;
    if (typeof credential !== "string" || credential.length === 0 || typeof delegationCid !== "string" || delegationCid.length === 0) {
      throw new ShareAuthorityError("AUTH_REQUIRED", "share recipient authorization requires an active OpenKey delegation");
    }
    const addressed = createAddressedAuthorization({
      nodeOrigin: config.nodeOrigin,
      trustedNode: { invitationKid: config.nodeInvitationKid, invitationPublicKey: config.nodeInvitationPublicKey },
      holderDid,
      sign: async (bytes) => {
        return node.signSessionBytes(bytes);
      },
      buildPresentation: async ({ challenge, envelope }) => {
        const authority = envelope.ownerAuthority;
        if (authority === undefined) throw new Error("addressed-owner-authority-missing");
        const nativeAction = (action: string): string => action === "list" ? "tinycloud.kv/list" : action === "edit" ? "tinycloud.kv/put" : "tinycloud.kv/get";
        const actions = [...new Set(envelope.actions.map(nativeAction))].sort();
        const action = envelope.actions.includes("list") ? "tinycloud.kv/list" : envelope.actions.includes("edit") ? "tinycloud.kv/put" : "tinycloud.kv/get";
        const policyCid = envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "";
        const enforcerDid = challenge.enforcerDid;
        if (typeof enforcerDid !== "string" || enforcerDid.length === 0) throw new ShareAuthorityError("UNAVAILABLE", "share authority returned an unbound challenge");
        const credentialDigest = base64UrlSha256(new TextEncoder().encode(credential));
        const jti = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
        const presentation = {
          type: "TinyCloudSharePolicyPresentation", version: 2, challengeId: challenge.challengeId, nonce: challenge.nonce,
          shareCid: authority.shareCid, shareId: envelope.shareId, delegationCid: envelope.delegationCid, policyCid,
          authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest,
          contentSource: envelope.contentSource, contentSourceDigest: envelope.contentSourceDigest, holderDid,
          targetOrigin: envelope.target.origin, nodeAudience: envelope.target.nodeAudience,
          enforcerDid, credentialDigest,
          action, actions, resource: envelope.resource.path.replace(/\/$/, ""), requestBodyDigest: challenge.requestBodyDigest,
          issuedAt: new Date().toISOString(), expiresAt: challenge.expiresAt, jti,
        };
        const signature = toBase64Url(await node.signSessionBytes(new TextEncoder().encode(`${SHARE_V2_PROTOCOL.sessionDomain}${canonicalize(presentation)}`)));
        const proof = { alg: "EdDSA", kid: `${holderDid}#${holderDid.slice("did:key:".length)}`, signature };
        const holderBinding = await createShareV2HolderBindingArtifact({
          holderDid,
          sign: (bytes) => node.signSessionBytes(bytes),
          message: {
            type: SHARE_V2_PROTOCOL.holderBindingType,
            version: SHARE_V2_PROTOCOL.holderBindingVersion,
            holderDid,
            challengeId: challenge.challengeId,
            challengeNonce: challenge.nonce,
            shareId: envelope.shareId,
            policyCid,
            credentialDigest,
            delegationCid,
            targetOrigin: envelope.target.origin,
            nodeAudience: envelope.target.nodeAudience,
            enforcerDid,
            expiresAt: challenge.expiresAt,
            jti,
          },
        });
        return {
          holderDid, credential, credentialDigest, presentation, presentationProof: proof,
          proof,
          holderBinding,
          sign: (bytes: Uint8Array) => node.signSessionBytes(bytes),
        };
      },
    });
    const matchesRecipient = (envelope: Parameters<ShareAuthorizationAdapter<ShareAuthorizedContent>["begin"]>[0]["envelope"]): boolean => envelope.authorizationTarget.kind !== "recipientDid" || (envelope.authorizationTarget.did === holderDid && envelope.recipientMatcher.kind === "recipientDid" && envelope.recipientMatcher.value === holderDid);
    return {
      async begin(request) { return matchesRecipient(request.envelope) ? addressed.begin(request) : { state: "denied", reason: "rejected" as const }; },
      async resume(request) { return matchesRecipient(request.envelope) ? addressed.resume(request) : { state: "denied", reason: "rejected" as const }; },
      verifyResult: addressed.verifyResult,
    };
  };
  const authorization: ShareAuthorizationAdapter<ShareAuthorizedContent> = input.authorize ?? {
    async begin(request) { return (await canonicalAuthorization()).begin(request); },
    async resume(request) { return (await canonicalAuthorization()).resume(request); },
    verifyResult: async (request) => (await canonicalAuthorization()).verifyResult?.(request) ?? false,
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
      idempotencyKey: request.idempotencyKey ?? `tinycloud-share:${record.shareId}`,
      expiresAt: new Date(Math.min(Date.parse(record.expiresAt), Date.now() + 5 * 60 * 1000)).toISOString(),
      nodeProof: { kid: config.nodeInvitationKid, publicKey: config.nodeInvitationPublicKey },
      credentialsAudience: config.credentialsOrigin,
    });
    const response = await postAddressedShareDelivery({
      credentialsOrigin: config.credentialsOrigin,
      receipt,
      shareUrl: record.link,
      fetchFn,
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
    records: input.profileName === undefined ? createEncryptedSessionHistory() : createEncryptedProfileHistory(input.profileName, async (bytes) => (await authenticatedNode()).signSessionBytes(bytes)),
    delivery,
    revocation,
    legacyReader,
    policyAuthority,
  };
}

async function selectedProfileName(): Promise<string> {
  const config = await ProfileManager.getConfig();
  return process.env.TC_PROFILE ?? config.defaultProfile;
}

function canonicalNodeOrigin(value: unknown): string {
  if (typeof value !== "string") throw new ShareAuthorityError("AUTH_REQUIRED", "share upload requires a configured Node host");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ShareAuthorityError("UNAVAILABLE", "configured Node host is invalid"); }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) || parsed.origin !== value || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ShareAuthorityError("UNAVAILABLE", "configured Node host is invalid");
  }
  return parsed.origin;
}

function canonicalNodeAudience(origin: string): string {
  return `did:web:${new URL(origin).hostname}`;
}

function base64UrlSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function authenticatedNodeForProfile(profileName: string, host: string): Promise<import("@tinycloud/node-sdk").TinyCloudNode> {
  const context = await ProfileManager.resolveContext({ profile: profileName, host });
  const { ensureAuthenticated } = await import("../lib/sdk.js");
  return ensureAuthenticated(context);
}

function strictUploadAttestation(value: unknown, upload: ShareUploadInput, origin: string, sessionDid: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ShareAuthorityError("UNAVAILABLE", "Node returned an invalid upload attestation");
  const record = value as Record<string, unknown>;
  const expectedKeys = ["type", "version", "issuer", "kid", "ownerDid", "sessionDid", "shareOrigin", "encryptedBlobCid", "encryptedBlobSha256", "byteLength", "deleteAfter", "retention", "issuedAt", "authorityExpiresAt", "expiresAt", "jti", "signature"];
  if (Object.keys(record).sort().join("\0") !== expectedKeys.sort().join("\0")) throw new ShareAuthorityError("UNAVAILABLE", "Node returned an invalid upload attestation");
  const sessionPrincipal = sessionDid.split("#", 1)[0];
  if (record.type !== "TinyCloudShareUploadAttestation" || record.version !== 1 || typeof record.issuer !== "string" || !record.issuer.startsWith("did:web:") || typeof record.kid !== "string" || !record.kid.startsWith(`${record.issuer}#`) || typeof record.ownerDid !== "string" || !record.ownerDid.startsWith("did:") || (record.sessionDid !== sessionDid && record.sessionDid !== sessionPrincipal) || typeof record.shareOrigin !== "string" || record.shareOrigin !== origin || record.encryptedBlobCid !== upload.cid || record.encryptedBlobSha256 !== base64UrlSha256(upload.blob) || record.byteLength !== upload.contentLength || record.deleteAfter !== upload.deleteAfter || record.retention === null || record.retention === undefined || typeof record.issuedAt !== "string" || typeof record.authorityExpiresAt !== "string" || typeof record.expiresAt !== "string" || typeof record.jti !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(record.jti) || typeof record.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(record.signature)) throw new ShareAuthorityError("UNAVAILABLE", "Node returned an invalid upload attestation");
  const issuedAt = Date.parse(record.issuedAt);
  const authorityExpiresAt = Date.parse(record.authorityExpiresAt);
  const expiresAt = Date.parse(record.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(authorityExpiresAt) || !Number.isFinite(expiresAt) || new Date(issuedAt).toISOString() !== record.issuedAt || new Date(authorityExpiresAt).toISOString() !== record.authorityExpiresAt || new Date(expiresAt).toISOString() !== record.expiresAt || authorityExpiresAt < expiresAt || expiresAt <= now || expiresAt - issuedAt > 120_000 || issuedAt > now + 30_000) throw new ShareAuthorityError("UNAVAILABLE", "Node returned an expired upload attestation");
  return record;
}

async function openKeyUploadAuthorization(input: { readonly fetchFn: typeof fetch; readonly origin: string; readonly profileName: string; readonly upload: ShareUploadInput; readonly node: import("@tinycloud/node-sdk").TinyCloudNode }): Promise<ShareUploadAuthorization> {
  const profile = await ProfileManager.getProfile(input.profileName).catch(() => {
    throw new ShareAuthorityError("AUTH_REQUIRED", "share upload requires an initialized profile");
  });
  if (profile.authMethod !== "openkey") throw new ShareAuthorityError("AUTH_REQUIRED", "share upload requires an OpenKey session");
  const session = await ProfileManager.getSession(input.profileName) as Record<string, unknown> | null;
  const sessionDid = session?.verificationMethod;
  if (session === null || typeof sessionDid !== "string" || !sessionDid.startsWith("did:key:") || typeof session.delegationHeader !== "object" || session.delegationHeader === null || typeof (session.delegationHeader as Record<string, unknown>).Authorization !== "string" || typeof session.delegationCid !== "string" || typeof session.spaceId !== "string") {
    throw new ShareAuthorityError("AUTH_REQUIRED", "share upload requires an active OpenKey session");
  }
  const requestWithoutDigest = {
    shareOrigin: input.origin,
    encryptedBlobCid: input.upload.cid,
    encryptedBlobSha256: base64UrlSha256(input.upload.blob),
    byteLength: input.upload.contentLength,
    deleteAfter: input.upload.deleteAfter,
    retention: "until-delete",
  };
  const requestBodyDigest = base64UrlSha256(new TextEncoder().encode(canonicalize(requestWithoutDigest)));
  const body = canonicalize({ ...requestWithoutDigest, requestBodyDigest });
  const entries = [{ spaceId: session.spaceId, service: "capabilities", action: "tinycloud.capabilities/read" }] as unknown as Parameters<import("@tinycloud/node-sdk").TinyCloudNode["invokeAny"]>[0];
  const nodeOrigin = canonicalNodeOrigin(profile.host);
  const activation = await activateSessionWithHost(nodeOrigin, session.delegationHeader as { Authorization: string });
  if (!activation.success) throw new ShareAuthorityError("AUTH_REQUIRED", "Node upload authorization was rejected");
  const invocationHeaders = new Headers(input.node.invokeAny(entries, [{ requestBodyDigest }]) as any);
  const invocation = invocationHeaders.get("authorization");
  if (invocation === null) throw new ShareAuthorityError("AUTH_REQUIRED", "Node upload authorization was rejected");
  const authorization = await input.node.bindInvocationAudience(invocation, canonicalNodeAudience(nodeOrigin));
  let response: Response;
  try {
    const headers = new Headers({ authorization });
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    response = await input.fetchFn(new URL("/share/upload/attestation", nodeOrigin), { method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", headers, body });
  } catch {
    throw new ShareAuthorityError("UNAVAILABLE", "Node upload authorization is unavailable");
  }
  if (response.status === 401 || response.status === 403) throw new ShareAuthorityError("AUTH_REQUIRED", "Node upload authorization was rejected");
  if (!response.ok) throw new ShareAuthorityError("UNAVAILABLE", "Node upload authorization is unavailable");
  let value: unknown;
  try { value = await response.json(); } catch { throw new ShareAuthorityError("UNAVAILABLE", "Node returned an invalid upload attestation"); }
  const attestation = strictUploadAttestation(value, input.upload, input.origin, sessionDid);
  return {
    "x-tinycloud-upload-attestation": JSON.stringify(attestation),
    "x-tinycloud-retention": canonicalize(attestation.retention),
  };
}

/**
 * Mints a one-shot Node upload attestation and returns only the canonical
 * Share authorization header. The session JWK and invocation header remain
 * in memory for the duration of this call.
 */
export function createProductionUploadAuthorizer(input: {
  readonly origin?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  /** Test-only seam; production uses the persisted OpenKey session. */
  readonly sessionAuthorization?: () => Promise<ShareUploadAuthorization | undefined>;
  /** Test-only explicit acquisition hook. */
  readonly acquireUploadAuthorization?: (input: { readonly profileName: string; readonly upload: ShareUploadInput }) => Promise<ShareUploadAuthorization | undefined>;
  /** Test-only resume hook. */
  readonly resumeUploadAuthorization?: (input: { readonly profileName: string; readonly resumeToken: string; readonly upload: ShareUploadInput }) => Promise<ShareUploadAuthorization | undefined>;
  /** Test-only seam. The production CLI entrypoint never sets this flag. */
  readonly testOnly?: boolean;
  /** Resolved by the command adapter so --profile always wins over defaults. */
  readonly profileName?: () => Promise<string>;
} = {}): (upload: ShareUploadInput) => Promise<ShareUploadAuthorization> {
  const origin = input.origin ?? DEFAULT_SHARE_ORIGIN;
  if (origin !== DEFAULT_SHARE_ORIGIN) throw new ShareAuthorityError("UNAVAILABLE", "share upload authorization is restricted to the canonical Share origin");
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  return async (upload) => {
    const profileName = await (input.profileName?.() ?? selectedProfileName());
    if (input.testOnly === true) {
      const suppliedSession = input.sessionAuthorization === undefined ? undefined : await input.sessionAuthorization();
      if (suppliedSession !== undefined) return suppliedSession;
      const acquired = await input.acquireUploadAuthorization?.({ profileName, upload });
      if (acquired !== undefined) return acquired;
    }
    const profile = await ProfileManager.getProfile(profileName).catch(() => {
      throw new ShareAuthorityError("AUTH_REQUIRED", "share upload requires an initialized profile");
    });
    if (profile.authMethod === "openkey") return openKeyUploadAuthorization({ fetchFn, origin, profileName, upload, node: await authenticatedNodeForProfile(profileName, profile.host) });
    throw new ShareAuthorityError("AUTH_REQUIRED", "share upload requires an active OpenKey session");
  };
}
