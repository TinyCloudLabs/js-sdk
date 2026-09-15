import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ProfileManager } from "../config/profiles.js";
import {
  createNativeShare,
  parseNativeShareUrl,
  SHARE_PUBLISH_RESULT_VERSION,
  publishAddressedShare,
  redactPublishedShare,
  type PublishedShare,
  type SenderShareRecord,
  type SenderShareRecordStorage,
  type TargetPublishAdapter,
  type ShareDeliveryAdapter,
  type ShareRevocationAdapter,
  type TargetPublishOutcome,
  type TargetPublishInput,
  deliverCredentialInvitation,
} from "@tinycloud/share-sdk";
import { canonicalize } from "@tinycloud/share-envelope";
import { revokePolicyRootV3 } from "@tinycloud/sdk-core";

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
  readonly credentialsOrigin: string;
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
  readonly credentialsOrigin?: string;
  readonly profileName?: () => Promise<string>;
  readonly fetchFn?: typeof globalThis.fetch;
  /** Injected in-process authority for tests or a host-specific deployment. */
  readonly publishTarget?: (value: TargetPublishInput) => Promise<TargetPublishOutcome>;
  readonly deliver?: ShareDeliveryAdapter["deliver"];
  readonly revokeDelegation?: ShareRevocationAdapter["revokeDelegation"];
  readonly revokePolicyRoot?: ShareRevocationAdapter["revokePolicyRoot"];
} = {}): {
  readonly targetAdapter: TargetPublishAdapter;
  readonly records: SenderShareRecordStorage;
  readonly delivery: ShareDeliveryAdapter;
  readonly revocation: ShareRevocationAdapter;
  readonly nativeReader: (link: string) => Promise<{ readonly bytes: Uint8Array; readonly filename: string }>;
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
    if (object.version !== "tinycloud.share/config-v2") throw new Error("share public config version is unsupported");
    return {
      shareOrigin: canonicalOrigin(object.shareOrigin, "origin"),
      registryOrigin: canonicalOrigin(object.registryOrigin, "registry origin"),
      credentialsOrigin: canonicalOrigin(input.credentialsOrigin ?? object.credentialsOrigin, "credentials origin"),
    };
  })();
  let nodePromise: Promise<Awaited<ReturnType<typeof import("../lib/sdk.js")["ensureAuthenticated"]>>> | undefined;
  const authenticatedNode = async () => nodePromise ??= (async () => {
    const profile = await (input.profileName?.() ?? selectedProfileName());
    const context = await ProfileManager.resolveContext({ profile, ...(input.nodeOrigin === undefined ? {} : { host: input.nodeOrigin }) });
    const { ensureAuthenticated } = await import("../lib/sdk.js");
    return ensureAuthenticated(context);
  })();
  const targetAdapter: TargetPublishAdapter = { async publish(targetInput) {
    if (input.publishTarget !== undefined) return input.publishTarget(targetInput);
    const [config, node] = await Promise.all([publicConfig(), authenticatedNode()]);
    if (targetInput.origin !== config.shareOrigin || node.spaceId === undefined) throw new Error("share publication is not bound to the configured Share service");
    const activeNode = await node.activeNodeIdentity();
    const shareId = crypto.randomUUID().replaceAll("-", "");
    const files = targetInput.files === undefined || targetInput.files.length === 0
      ? [{ bytes: targetInput.source, filename: targetInput.filename, mediaType: targetInput.mediaType }]
      : targetInput.files;
    const resourceKind = targetInput.resourceKind ?? "exact";
    if (targetInput.target.kind === "bearer") {
      if (resourceKind !== "exact" || files.length !== 1) throw new Error("native bearer publication requires one exact source file");
      const file = files[0]!;
      const resourcePath = `xyz.tinycloud.share/shares/${shareId}/${targetInput.filename}`;
      const written = await node.kvForSpace(node.spaceId).put(resourcePath, file.bytes.slice(), {
        contentType: targetInput.mediaType ?? file.mediaType ?? "application/octet-stream",
      });
      if (!written.ok) throw new Error("native bearer source upload was rejected");
      const native = await createNativeShare(node.sharing, {
        path: resourcePath,
        expiresAt: targetInput.expiresAt,
        viewerOrigin: config.shareOrigin,
      });
      if (native.spaceId !== node.spaceId) throw new Error("native bearer delegation authority does not match the authenticated owner space");
      const result = {
        protocol: "tinycloud-share" as const,
        version: SHARE_PUBLISH_RESULT_VERSION,
        url: native.url,
        link: { kind: "native" as const, cid: native.delegationCid },
        metadata: {
          protocol: "tinycloud-share" as const,
          version: 1 as const,
          shareId: native.delegationCid,
          origin: config.shareOrigin,
          target: { kind: "bearer" as const, origin: activeNode.origin, nodeAudience: activeNode.nodeDid, spaceId: native.spaceId },
          resource: { kind: "exact" as const, path: resourcePath },
          actions: ["read"],
          expiresAt: native.expiresAt.toISOString(),
          display: { filename: targetInput.filename },
          recipientMatcher: { kind: "bearer" as const },
          enforcementDelegationCid: native.delegationCid,
        },
      } satisfies PublishedShare;
      Object.defineProperty(result, "toJSON", { enumerable: false, value: () => redactPublishedShare(result) });
      Object.defineProperty(result, "url", { enumerable: false, value: native.url });
      return result;
    }
    // A v3 addressed share is bound to one wrapped content key, so the
    // encrypted source is a single exact KV resource. Prefix fan-out would
    // need a shared key the envelope does not carry.
    if (resourceKind !== "exact" || files.length !== 1) throw new Error("addressed publication requires a single exact source file");
    const file = files[0]!;
    const resourcePath = `shares/${shareId}/${targetInput.filename}`;
    const byteLength = file.bytes.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > 100 * 1024 * 1024) throw new Error("addressed publication exceeds the combined byte limit");
    const mediaType = targetInput.mediaType ?? file.mediaType ?? "application/octet-stream";
    const encryptionNetwork = node.getEncryptionNetworkIdForSpace(node.spaceId);
    const encrypted = await node.encryption.encryptToNetwork(encryptionNetwork, file.bytes, { metadata: { contentType: mediaType } });
    if (!encrypted.ok) throw new Error("addressed source encryption was rejected");
    const storedBytes = new TextEncoder().encode(canonicalize(encrypted.data as unknown as Record<string, unknown>));
    const stored = await node.kvForSpace(node.spaceId).put(resourcePath, storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
    if (!stored.ok) throw new Error("addressed source upload was rejected");
    const contentSource = {
      shareId,
      kvResource: `${node.spaceId}/kv/${resourcePath}`,
      selector: resourceKind,
      encryptionNetwork: encrypted.data.networkId,
      encryptedSymmetricKeyDigestHex: encrypted.data.encryptedSymmetricKeyHash,
      keyVersion: encrypted.data.keyVersion,
      mode: "immutable" as const,
      initialCiphertextDigestHex: createHash("sha256").update(storedBytes).digest("hex"),
    };
    const actions = targetInput.actions === undefined || targetInput.actions.length === 0 ? ["read"] as const : targetInput.actions;
    const policyActions = [...new Set(actions.flatMap((action) => action === "read" ? ["tinycloud.kv/get", "tinycloud.kv/metadata"] : action === "list" ? ["tinycloud.kv/list"] : ["tinycloud.kv/put"]))] as ("tinycloud.kv/get" | "tinycloud.kv/list" | "tinycloud.kv/metadata" | "tinycloud.kv/put")[];
    return publishAddressedShare({
      shareId,
      shareOrigin: config.shareOrigin,
      nodeOrigin: activeNode.origin,
      nodeAudience: activeNode.nodeDid,
      enforcerDid: activeNode.nodeDid,
      spaceId: node.spaceId,
      target: targetInput.target,
      resource: { kind: resourceKind, path: resourcePath },
      actions,
      policyActions,
      contentSource,
      filename: targetInput.filename,
      mediaType,
      byteLength,
      expiresAt: targetInput.expiresAt,
      // App-neutral owner authority: the Node SDK owns every Policy/v3
      // transport hop, so the CLI supplies only owner signing material.
      authority: {
        ownerDid: node.credentialHolderDid,
        createOwnerRoot: (request) => node.createUnifiedOwnerRoot(request),
        sign: (bytes) => node.signSessionBytes(bytes),
        registerPolicy: (request) => node.registerPolicy(request),
      },
    });
  } };
  const delivery: ShareDeliveryAdapter = { deliver: input.deliver ?? (async (request) => {
    const record = request.record;
    if (
      record === undefined
      || record.link === undefined
      || record.deliveryMaterial === undefined
      || request.idempotencyKey === undefined
    ) throw new Error("share delivery history is incomplete");
    const [config, node] = await Promise.all([publicConfig(), authenticatedNode()]);
    // Bind the JTI to a process-stable body for the full Node retry window.
    // `registeredAt` is persisted before notification starts, so a recreated
    // adapter derives the same expiry without retaining unbounded local state.
    const authorizationExpiresAt = new Date(Math.min(
      Date.parse(record.expiresAt),
      Date.parse(record.registeredAt) + 5 * 60 * 1000,
    )).toISOString();
    if (Date.parse(authorizationExpiresAt) <= Date.now()) throw new Error("share delivery authorization retry window has expired");
    const receipt = await node.authorizeShareDeliveryV3({
      envelope: record.deliveryMaterial.envelope as Parameters<typeof node.authorizeShareDeliveryV3>[0]["envelope"],
      sealedEnvelope: record.deliveryMaterial.sealedEnvelope,
      envelopeKey: record.deliveryMaterial.envelopeKey,
      shareCid: record.deliveryMaterial.shareCid,
      resourcePath: record.resource.path,
      recipientEmail: request.recipient,
      shareUrl: record.link,
      documentName: record.filename ?? "share.md",
      expiresAt: authorizationExpiresAt,
      deliveryAudience: config.credentialsOrigin,
      idempotencyKey: request.idempotencyKey,
    });
    await deliverCredentialInvitation({
      credentialsOrigin: config.credentialsOrigin,
      receipt,
      shareUrl: record.link,
      fetchFn,
      signal: request.signal,
    });
    return "delivered";
  }) };
  const revocation: ShareRevocationAdapter = {
    revokeDelegation: input.revokeDelegation ?? (async (request) => {
      const result = await (await authenticatedNode()).revokeDelegation(request.delegationCid);
      if (!result.ok) throw new Error("share delegation revocation was rejected");
    }),
    revokePolicyRoot: input.revokePolicyRoot ?? (async (request) => {
      const node = await authenticatedNode();
      const activeNode = await node.activeNodeIdentity();
      if (request.nodeOrigin !== activeNode.origin || request.nodeAudience !== activeNode.nodeDid || request.ownerDid !== node.credentialHolderDid) {
        throw new Error("share Policy/v3 revocation is not bound to the active owner node");
      }
      await revokePolicyRootV3({
        nodeOrigin: activeNode.origin,
        rootCid: request.rootCid,
        targetRole: request.targetRole,
        ownerDid: node.credentialHolderDid,
        issuerDid: node.credentialHolderDid,
        nodeAudience: activeNode.nodeDid,
        reason: "share revoked",
        sign: (digest) => node.signSessionBytes(digest),
      });
    }),
  };
  const nativeReader = async (link: string): Promise<{ readonly bytes: Uint8Array; readonly filename: string }> => {
    const { TinyCloudNode } = await import("@tinycloud/node-sdk");
    const token = parseNativeShareUrl(link);
    const decoder = new TinyCloudNode({ autoDiscoverLocalNode: false });
    const decoded = decoder.sharing.decodeLink(token) as { readonly host?: unknown };
    if (typeof decoded.host !== "string") throw new Error("native share has no owner Node");
    const client = new TinyCloudNode({ host: canonicalOrigin(decoded.host, "owner node origin"), autoDiscoverLocalNode: false });
    const received = await client.sharing.receive(token, { autoSubdelegate: false, useSessionKey: false });
    if (!received.ok) throw new Error("native share could not be verified");
    const value = await received.data.kv.get<Uint8Array>("", { binary: true });
    if (!value.ok || !(value.data.data instanceof Uint8Array)) throw new Error("native share content could not be read");
    return { bytes: value.data.data.slice(), filename: received.data.path.split("/").at(-1) || "share.md" };
  };
  return {
    targetAdapter,
    records: input.profileName === undefined ? createEncryptedSessionHistory() : createEncryptedProfileHistory(input.profileName, async (bytes) => {
      // Bearer-share history only needs the already-established local session
      // signer. Do not fetch Share public configuration or initialize addressed
      // authority services after a successful upload.
      const profileName = await input.profileName!();
      const context = await ProfileManager.resolveContext({ profile: profileName });
      const { ensureAuthenticated } = await import("../lib/sdk.js");
      return (await ensureAuthenticated(context)).signSessionBytes(bytes);
    }),
    delivery,
    revocation,
    nativeReader,
  };
}

async function selectedProfileName(): Promise<string> {
  const config = await ProfileManager.getConfig();
  return process.env.TC_PROFILE ?? config.defaultProfile;
}
