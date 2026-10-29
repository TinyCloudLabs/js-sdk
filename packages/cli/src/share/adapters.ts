import type { IKVService } from "@tinycloud/node-sdk";
import { kvArtifactStore } from "./artifact-store.js";
import { createShareLinks, type ShareLinks } from "./short-links.js";
import { publishEmailShareV3 } from "./email-publish-v3.js";
import { artifactSpaceNotReady, failIfSpaceNotReady } from "./space-not-ready.js";
import { ShareHistoryReadError, ShareHistoryRetryError, ShareHistoryUnreadableError, SharePublishAuthorityError } from "./errors.js";
import { storageRejection } from "../output/storage.js";
import { chmod, link, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode, PROFILE_COMMIT_LOCK_TIMEOUT_MS } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { isSessionExpiredError } from "../auth/session-expired.js";
import { isVerifiedRawEncryptionPermission } from "../lib/raw-encryption.js";
import { writeJsonAtomic } from "@tinycloud/operations/state";
import { withoutBearer } from "@tinycloud/operations/delegation-binding";
import {
  ArtifactError,
  artifactVersionFilePath,
  buildArtifactPin,
  publishArtifactVersion,
  type ArtifactVersionInput,
  type ArtifactStore,
  type ArtifactVersionResult,
} from "@tinycloud/share-sdk/artifact";
import {
  createNativeShare,
  parseNativeShareUrl,
  SHARE_PUBLISH_RESULT_VERSION,
  prepareAddressedShare,
  type PreparedAddressedShare,
  publishAddressedShare,
  redactPublishedShare,
  type NativeShareResult,
  type PublishedShare,
  type SenderShareRecord,
  type SenderShareRecordStorage,
  type TargetPublishAdapter,
  type ShareDeliveryAdapter,
  type ShareRevocationAdapter,
  type TargetPublishOutcome,
  type TargetPublishInput,
  ShareNotifyError,
  shareDeliveryWindowExpiresAt,
  deliverCredentialInvitation,
} from "@tinycloud/share-sdk";
import { canonicalize, isEnvelopeDeliveryEmail } from "@tinycloud/share-envelope";
import {
  LocationRecordValidationError,
  LocationRegistryHttpError,
  parseSignedCompactUcanAttenuation,
  parseSignedSiweCacao,
  revokePolicyRootV3,
  signCompactUcanAuthorization,
  isCapabilitySubset,
  type PermissionEntry,
} from "@tinycloud/sdk-core";
import { extractSiweExpiration, InvalidRestoredSessionError, type TinyCloudNode } from "@tinycloud/node-sdk";
import {
  AddressedShareOverLimitError,
  assertAddressedShareFits,
  type AddressedShareWrites,
  type AddressedSharePublishOptions,
  type SharePolicyRootRevocation,
} from "@tinycloud/share-sdk";

function requiredKvAction(meta: unknown): "tinycloud.kv/put" | "tinycloud.kv/get" | "tinycloud.kv/list" | undefined {
  if (meta === null || typeof meta !== "object" || !("requiredAction" in meta)) return undefined;
  const action = meta.requiredAction;
  return action === "tinycloud.kv/put" || action === "tinycloud.kv/get" || action === "tinycloud.kv/list" ? action : undefined;
}
/** A storage refusal stays one with or without account totals; the Node's text never reaches output. */
function throwKvUploadFailure(error: unknown): never {
  const rejection = storageRejection(error);
  if (rejection) throw new SharePublishAuthorityError({ kind: "storage-full", ...rejection });
  throw new SharePublishAuthorityError({ kind: "upload-failed" });
}

/**
 * What an over-limit publish leaves behind, and what it removes. The size bound makes this unreachable for a correct
 * publish; if the sealed envelope is over the limit anyway, the owner roots are revoked (the registered policy then
 * admits no one) and a plain share's uploaded ciphertext is deleted. The registered policy record, the registry's
 * location record (one per owner, shared by every share) and a pinned artifact version (write-once) cannot be removed.
 * Returns a sentence for each thing that stays.
 */
async function removeOverLimitShare(input: {
  readonly written: AddressedShareWrites;
  readonly revokeRoot: (request: SharePolicyRootRevocation) => Promise<void>;
  readonly owner: Omit<SharePolicyRootRevocation, "rootCid" | "targetRole">;
  readonly content: { readonly kind: "object"; readonly path: string; readonly remove: () => Promise<void> } | { readonly kind: "artifact"; readonly id: string; readonly version: number };
}): Promise<readonly string[]> {
  const remaining: string[] = [];
  let rootsRevoked = true;
  for (const [rootCid, targetRole] of [[input.written.enforcementRootCid, "policy-enforcement"], [input.written.policyRootCid, "policy-authority"]] as const) {
    try {
      await input.revokeRoot({ ...input.owner, rootCid, targetRole });
    } catch {
      rootsRevoked = false;
      remaining.push(`the ${targetRole} root ${rootCid} could not be revoked`);
    }
  }
  if (rootsRevoked) remaining.push("a policy record stays on your node with both of its roots revoked, so it admits no one");
  // The publish wrote the registry's location record before any content; the registry keeps one per owner for every share.
  remaining.push("your node's location record stays in the TinyCloud registry, shared by all your shares");
  if (input.content.kind === "artifact") {
    remaining.push(`artifact ${input.content.id} version ${input.content.version} stays in your space, because artifact versions are write-once`);
  } else {
    try {
      await input.content.remove();
    } catch {
      remaining.push(`the uploaded encrypted file ${input.content.path} could not be deleted`);
    }
  }
  return remaining;
}

/** Check the exact decrypt resource against signed, active authority, not static manifest input. */
export function sessionHoldsEncryptionDecrypt(
  node: Pick<TinyCloudNode, "getVerifiedSessionCapabilities" | "getEffectiveRuntimePermissionEntries">,
  resource: string,
): boolean {
  const requested = [{ service: "tinycloud.encryption", space: "encryption", path: resource, actions: ["tinycloud.encryption/decrypt"] }];
  const covers = (entries: PermissionEntry[]): boolean =>
    isCapabilitySubset(requested, entries.filter(isVerifiedRawEncryptionPermission).map((entry) => ({ ...entry, space: "encryption" }))).subset;
  return covers(node.getVerifiedSessionCapabilities()) || covers(node.getEffectiveRuntimePermissionEntries());
}
const DEFAULT_SHARE_ORIGIN = "https://share.tinycloud.xyz";
const MIN_DOMAIN_DELIVERY_VERSION = "1.17.3";
/** Compared with a release threshold: equal numeric prereleases sort below it. */
function supportsDomainDelivery(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const normalized = version.trim();
  if (normalized.length > 128) return false;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(normalized);
  if (match === null) return false;
  if (match[4] !== undefined && /(?:^|\.)0[0-9]+(?:\.|$)/.test(match[4])) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return false;
  if (major !== 1) return major > 1;
  if (minor !== 17) return minor > 17;
  if (patch !== 3) return patch > 3;
  return match[4] === undefined;
}

function displayedNodeVersion(version: unknown): string {
  if (typeof version !== "string") return "(unrecognized)";
  const trimmed = version.trim();
  return /^[A-Za-z0-9.+_-]{1,64}$/.test(trimmed) ? trimmed : "(unrecognized)";
}
const URI_SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * The SDK puts KV keys unescaped into the Node resource URI, so a stored name
 * keeps only URI-safe characters, and never `..`, which share links refuse.
 * It stays readable and keeps a plain extension because the share viewer
 * titles and renders bearer links by this segment; a name without one never
 * gains one. The original filename travels separately as display metadata.
 */
function safeStorageFilename(filename: string): string {
  if (URI_SAFE_FILENAME.test(filename) && !filename.includes("..")) return filename;
  const dot = filename.lastIndexOf(".");
  const extension = dot >= 0 && /^[A-Za-z0-9]{1,16}$/.test(filename.slice(dot + 1)) ? filename.slice(dot + 1) : "";
  const stem = (extension === "" ? filename : filename.slice(0, dot))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(extension === "" ? /[^A-Za-z0-9_-]+/g : /[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .slice(0, 100)
    .replace(/^[^A-Za-z0-9]+|[-.]+$/g, "");
  return `${stem === "" ? "share" : stem}${extension === "" ? "" : `.${extension}`}`;
}

/** A denied KV call during an artifact operation, as the usual scope error (and its re-login hint). */
function scopeDeniedFromArtifactError(
  error: unknown,
  capability: "KV upload" | "artifact storage",
  authority: { readonly localKey: boolean; readonly profileName: string | undefined },
): SharePublishAuthorityError | undefined {
  const cause = error instanceof ArtifactError ? error.cause : undefined;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  if (code !== "AUTH_UNAUTHORIZED" && code !== "PERMISSION_DENIED") return undefined;
  const meta = typeof cause === "object" && cause !== null && "meta" in cause ? cause.meta : undefined;
  const requiredAction = requiredKvAction(meta);
  return new SharePublishAuthorityError({
    kind: "scope-denied",
    capability,
    ...(requiredAction === undefined ? {} : { requiredAction }),
    localKey: authority.localKey,
    profileName: authority.profileName,
  });
}

/** Claim the next artifact version, reporting a KV authority failure as the usual scope error. */
async function storeArtifactVersion(
  kv: IKVService,
  version: ArtifactVersionInput,
  authority: { readonly localKey: boolean; readonly profileName: string | undefined },
): Promise<ArtifactVersionResult> {
  try {
    return await publishArtifactVersion(kvArtifactStore(kv), version);
  } catch (error) {
    throw scopeDeniedFromArtifactError(error, "KV upload", authority) ?? artifactSpaceNotReady(error);
  }
}

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
  let operation = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => { const next = operation.then(action, action); operation = next.then(() => undefined, () => undefined); return next; };
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
    async put(record) { return serial(async () => { records.set(record.shareId, await encode(record)); }); },
    async update(shareId, change) {
      return serial(async () => {
        const value = records.get(shareId);
        if (value === undefined) return undefined;
        const updated = await change(await decode(value));
        records.set(shareId, await encode(updated));
        return updated;
      });
    },
    async list() { return serial(() => Promise.all([...records.values()].map(decode))); },
    async get(shareId) { return serial(async () => { const value = records.get(shareId); return value === undefined ? undefined : decode(value); }); },
    async delete(shareId) { return serial(async () => { records.delete(shareId); }); },
  };
}

const SHARE_HISTORY_FILE = "share-history-v2.json";
const SHARE_HISTORY_LEGACY_FILE = "share-history-v1.bin";
/** Owner-only, matching the mode the history writer already uses. */
const PRIVATE_HISTORY_MODE = 0o600;

/** Signs the bytes that seed a profile's sender-history key. Shared by the publish wiring and the rotation guard. */
export async function signShareHistoryBytes(bytes: Uint8Array, profile: string): Promise<Uint8Array> {
  // Authentication or delegation replay can use the network. The history
  // adapter prepares this signature before acquiring the profile lock.
  const context = await ProfileManager.resolveContext({ profile });
  if (context.profile !== profile) throw new ShareHistoryRetryError(profile);
  const { ensureAuthenticated } = await import("../lib/sdk.js");
  const signer = await ensureAuthenticated(context);
  return signer.signSessionBytes(bytes);
}

/** Profile sender history, plus the explicit recovery of an unreadable file. */
export type ProfileShareHistory = SenderShareRecordStorage & {
  /** Moves an unreadable history file aside under a new name. Never deletes or overwrites. */
  quarantineUnreadable(): Promise<string | null>;
};

export function createEncryptedProfileHistory(profileName: () => Promise<string>, sessionSigner?: (bytes: Uint8Array, profile: string) => Promise<Uint8Array>): ProfileShareHistory {
  const HISTORY_VERSION = 2;
  const identityChanged = new Error("share history profile or key changed");
  const saltChanged = new Error("share history salt changed");
  let operation = Promise.resolve();
  const observedProfiles = new Set<string>();
  let preparedKeys: { readonly profile: string; readonly identity: string; readonly material: CryptoKey; readonly legacyKey: CryptoKey } | undefined;
  let preparedKey: { readonly profile: string; readonly identity: string; readonly salt: string; readonly key: CryptoKey } | undefined;
  const path = async (profile: string): Promise<string> => join(await ProfileManager.getCacheDir(profile), SHARE_HISTORY_FILE);
  const legacyPath = async (profile: string): Promise<string> => join(await ProfileManager.getCacheDir(profile), SHARE_HISTORY_LEGACY_FILE);
  const b64 = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
  const unb64 = (value: unknown): Uint8Array => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ShareHistoryUnreadableError();
    const bytes = new Uint8Array(Buffer.from(value, "base64url"));
    if (b64(bytes) !== value) throw new ShareHistoryUnreadableError();
    return bytes;
  };
  const isStoredRecord = (value: unknown): value is SenderShareRecord =>
    typeof value === "object" && value !== null && "shareId" in value && typeof value.shareId === "string";
  const identity = async (profile: string) => {
    const config = await ProfileManager.getProfile(profile);
    const localKey = typeof config.privateKey === "string" && config.privateKey.length > 0;
    const [key, session] = localKey ? [null, null] : await Promise.all([ProfileManager.getKey(profile), ProfileManager.getSession(profile)]);
    const sessionJwk = session !== null && "jwk" in session ? session.jwk : undefined;
    const signerJwk = sessionJwk !== null && typeof sessionJwk === "object" && "d" in sessionJwk && typeof sessionJwk.d === "string" && sessionJwk.d.length > 0
      ? sessionJwk : key;
    const method = session !== null && "verificationMethod" in session ? session.verificationMethod ?? config.did : config.did;
    const fingerprint = createHash("sha256").update(JSON.stringify(localKey
      ? ["local", config.privateKey]
      : ["openkey", sessionJwk, signerJwk, method])).digest("hex");
    return { config, fingerprint };
  };
  const prepareKeys = async (profile: string, snapshot: Awaited<ReturnType<typeof identity>>) => {
    if (preparedKeys?.profile === profile && preparedKeys.identity === snapshot.fingerprint) return preparedKeys;
    let secret: Uint8Array;
    if (typeof snapshot.config.privateKey === "string" && snapshot.config.privateKey.length > 0) {
      secret = new TextEncoder().encode(snapshot.config.privateKey);
    } else {
      if (sessionSigner === undefined) throw new Error("share history requires an initialized profile");
      // Restoring this signer may replay delegations over the network. Never
      // initiate it from a profile-lock callback.
      secret = await sessionSigner(new TextEncoder().encode("xyz.tinycloud.share/history-key/v1"), profile);
    }
    if ((await identity(profile)).fingerprint !== snapshot.fingerprint) throw identityChanged;
    const material = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveKey"]);
    const digest = await crypto.subtle.digest("SHA-256", secret);
    const legacyKey = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
    return preparedKeys = { profile, identity: snapshot.fingerprint, material, legacyKey };
  };
  /** The file's bytes, or undefined when it does not exist. Any other filesystem error is a read failure. */
  const readIfPresent = async (file: string): Promise<Buffer | undefined> => {
    try {
      return await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ShareHistoryReadError();
    }
  };
  const parseEnvelope = (text: string): Record<string, unknown> => {
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new ShareHistoryUnreadableError();
    }
    if (typeof envelope !== "object" || envelope === null || (envelope as Record<string, unknown>).version !== HISTORY_VERSION) throw new ShareHistoryUnreadableError();
    return envelope as Record<string, unknown>;
  };
  const decryptRecords = async (key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<SenderShareRecord[]> => {
    try {
      const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      const values = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      return Array.isArray(values) ? values.filter(isStoredRecord) : [];
    } catch {
      throw new ShareHistoryUnreadableError();
    }
  };
  const preparedSalt = async (profile: string): Promise<Uint8Array> => {
    const file = await readIfPresent(await path(profile));
    if (file === undefined) return crypto.getRandomValues(new Uint8Array(16));
    const salt = unb64(parseEnvelope(file.toString("utf8")).kdfSalt);
    if (salt.length < 16) throw new ShareHistoryUnreadableError();
    return salt;
  };
  const read = async (profile: string, ready: { readonly salt: Uint8Array; readonly key: CryptoKey; readonly legacyKey: CryptoKey }): Promise<SenderShareRecord[]> => {
    const file = await readIfPresent(await path(profile));
    if (file === undefined) {
      const legacy = await readIfPresent(await legacyPath(profile));
      if (legacy === undefined || legacy.length <= 12) return [];
      return decryptRecords(ready.legacyKey, new Uint8Array(legacy.subarray(0, 12)), new Uint8Array(legacy.subarray(12)));
    }
    const envelope = parseEnvelope(file.toString("utf8"));
    if (envelope.kdfSalt !== b64(ready.salt)) throw saltChanged;
    const iv = unb64(envelope.iv);
    const ciphertext = unb64(envelope.ciphertext);
    if (iv.length !== 12 || ciphertext.length <= 16) throw new ShareHistoryUnreadableError();
    return decryptRecords(ready.key, iv, ciphertext);
  };
  const write = async (profile: string, values: readonly SenderShareRecord[], ready: { readonly salt: Uint8Array; readonly key: CryptoKey }): Promise<void> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new TextEncoder().encode(JSON.stringify(values));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ready.key, bytes));
    await writeJsonAtomic(await path(profile), { version: HISTORY_VERSION, kdfSalt: b64(ready.salt), iv: b64(iv), ciphertext: b64(encrypted) });
  };
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = operation.then(action, action);
    operation = next.then(() => undefined, () => undefined);
    return next;
  };
  const locked = <T>(action: (profile: string, ready: { readonly salt: Uint8Array; readonly key: CryptoKey; readonly legacyKey: CryptoKey }) => Promise<T>, writing = false): Promise<T> => serial(async () => {
    // An invocation may change its default profile while this operation waits.
    // A salt retry must never move its record to that other profile.
    const profile = await profileName();
    let warned = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const snapshot = await identity(profile);
        observedProfiles.add(profile);
        const keys = await prepareKeys(profile, snapshot);
        const salt = await preparedSalt(profile);
        const saltId = b64(salt);
        const key = preparedKey?.profile === profile && preparedKey.identity === snapshot.fingerprint && preparedKey.salt === saltId
          ? preparedKey.key
          : await crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
            keys.material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
          );
        preparedKey = { profile, identity: snapshot.fingerprint, salt: saltId, key };
        // Warn only while waiting to acquire a write lock, not while decrypting
        // or updating inside it. Salt retries emit at most one line altogether.
        const warning = writing ? setTimeout(() => {
          if (!warned) {
            warned = true;
            process.stderr.write(`Waiting for profile lock for ${JSON.stringify(profile)} before updating sender history.\n`);
          }
        }, 2_000) : undefined;
        warning?.unref();
        try {
          return await ProfileManager.withLock(profile, async () => {
            clearTimeout(warning);
            if ((await identity(profile)).fingerprint !== snapshot.fingerprint) throw identityChanged;
            return action(profile, { salt, key, legacyKey: keys.legacyKey });
          }, writing ? { timeoutMs: PROFILE_COMMIT_LOCK_TIMEOUT_MS } : undefined);
        } finally {
          clearTimeout(warning);
        }
      } catch (error) {
        // Another process may have created the first file or changed this
        // profile's signer inputs. Derive the new key outside the lock.
        if (error === saltChanged || error === identityChanged) continue;
        if (observedProfiles.has(profile) && typeof error === "object" && error !== null && "code" in error && error.code === "PROFILE_NOT_FOUND") {
          throw new ShareHistoryRetryError(profile);
        }
        throw error;
      }
    }
    throw new ShareHistoryRetryError(profile);
  });
  // Runs without the profile lock: deriving the signer can replay delegations over the network.
  const firstPresentHistoryFile = async (profile: string): Promise<{ readonly file: string; readonly bytes: Buffer } | undefined> => {
    for (const file of [await path(profile), await legacyPath(profile)]) {
      const bytes = await readIfPresent(file);
      if (bytes !== undefined) return { file, bytes };
    }
    return undefined;
  };
  const readableWithCurrentKey = async (profile: string): Promise<boolean> => {
    const snapshot = await identity(profile);
    const keys = await prepareKeys(profile, snapshot);
    try {
      const salt = await preparedSalt(profile);
      const key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
        keys.material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
      );
      await read(profile, { salt, key, legacyKey: keys.legacyKey });
      return true;
    } catch (error) {
      if (error instanceof ShareHistoryUnreadableError) return false;
      throw error;
    }
  };
  const quarantineUnreadable = (): Promise<string | null> => serial(async () => {
    const profile = await profileName();
    const found = await firstPresentHistoryFile(profile);
    if (found === undefined) return null;
    let readable: boolean;
    try {
      readable = await readableWithCurrentKey(profile);
    } catch (error) {
      if (error === identityChanged || error === saltChanged) throw new ShareHistoryRetryError(profile);
      throw error;
    }
    if (readable) return null;
    return ProfileManager.withLock(profile, async () => {
      // Confirm under the lock that the bytes probed above are still the bytes on disk.
      const current = await readIfPresent(found.file);
      if (current === undefined) return null;
      if (!current.equals(found.bytes)) throw new ShareHistoryRetryError(profile);
      const target = `${found.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      // link never replaces an existing target, so a name collision fails instead of clobbering.
      await link(found.file, target);
      await chmod(target, PRIVATE_HISTORY_MODE);
      await unlink(found.file);
      const directory = await open(dirname(found.file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return target;
    });
  });

  return {
    async put(record) { return locked(async (profile, ready) => { const values = await read(profile, ready); const index = values.findIndex((value) => value.shareId === record.shareId); if (index >= 0) values[index] = record; else values.push(record); await write(profile, values, ready); }, true); },
    async update(shareId, change) {
      return locked(async (profile, ready) => {
        const values = await read(profile, ready);
        const index = values.findIndex((record) => record.shareId === shareId);
        if (index < 0) return undefined;
        const updated = await change(values[index]!);
        values[index] = updated;
        await write(profile, values, ready);
        return updated;
      }, true);
    },
    async list() { return locked((profile, ready) => read(profile, ready)); },
    async get(shareId) { return locked(async (profile, ready) => (await read(profile, ready)).find((record) => record.shareId === shareId)); },
    async delete(shareId) { return locked(async (profile, ready) => { await write(profile, (await read(profile, ready)).filter((record) => record.shareId !== shareId), ready); }, true); },
    quarantineUnreadable,
  };
}

/** Whether either sender-history file exists for the profile. */
export async function profileHistoryFileExists(profileName: string): Promise<boolean> {
  const directory = await ProfileManager.getCacheDir(profileName);
  for (const file of [join(directory, SHARE_HISTORY_FILE), join(directory, SHARE_HISTORY_LEGACY_FILE)]) {
    try {
      await stat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ShareHistoryReadError();
    }
  }
  return false;
}

/** Explicit recovery only: moves an unreadable profile history file aside. Returns the new path, or null when nothing was moved. */
export function quarantineUnreadableProfileHistory(profileName: string): Promise<string | null> {
  return createEncryptedProfileHistory(async () => profileName, signShareHistoryBytes).quarantineUnreadable();
}

/** Default noninteractive authority seams.  They return typed authorization
 * outcomes until an OpenKey/Node adapter is installed; commands never fall
 * through to an unconfigured legacy service or invent a successful result. */
export function createShareAuthorityAdapters(input: {
  readonly origin?: string;
  readonly nodeOrigin?: string;
  readonly credentialsOrigin?: string;
  /** Resolved once for both node authentication and all sender-history operations. */
  readonly profileName?: () => Promise<string>;
  readonly fetchFn?: typeof globalThis.fetch;
  /** Injected in-process authority for tests or a host-specific deployment. */
  readonly publishTarget?: (value: TargetPublishInput) => Promise<TargetPublishOutcome>;
  readonly deliver?: ShareDeliveryAdapter["deliver"];
  readonly revokeDelegation?: ShareRevocationAdapter["revokeDelegation"];
  readonly revokePolicyRoot?: ShareRevocationAdapter["revokePolicyRoot"];
  /** Bearer-link sharing service: `undefined` host decodes the link, a host reads from that owner Node. */
  readonly nativeSharing?: (host: string | undefined) => TinyCloudNode["sharing"];
} = {}): {
  readonly targetAdapter: TargetPublishAdapter;
  readonly records: SenderShareRecordStorage;
  readonly delivery: ShareDeliveryAdapter;
  readonly revocation: ShareRevocationAdapter;
  readonly assertDomainDelivery: () => Promise<void>;
  readonly nativeReader: (link: string) => Promise<{ readonly bytes: Uint8Array; readonly filename: string }>;
  /** The authenticated owner's artifact storage (`tc share versions`). */
  readonly artifactStore: () => Promise<ArtifactStore>;
  /** Links for addressed shares (TC-1737). */
  readonly links: ShareLinks;
} {
  const origin = input.origin ?? DEFAULT_SHARE_ORIGIN;
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  let selectedProfile: Promise<string> | undefined;
  const profileName = (): Promise<string> => selectedProfile ??= input.profileName?.() ?? selectedProfileName();
  const canonicalOrigin = (value: unknown, label: string): string => {
    if (typeof value !== "string") throw new Error(`share ${label} is unavailable`);
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) || parsed.origin !== value) throw new Error(`share ${label} is invalid`);
    return value;
  };
  let configPromise: Promise<SharePublicConfig> | undefined;
  const publicConfig = async (): Promise<SharePublicConfig> => configPromise ??= (async () => {
    // The first request of every publish. Without it nothing can be shared, so a failure here names the Share
    // service rather than the node, and a blackholed host cannot hang the command.
    let response: Response;
    try {
      response = await fetchFn(`${origin}/.well-known/tinycloud-share/config.json`, {
        headers: { accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new SharePublishAuthorityError({ kind: "share-service-unavailable", origin }, { cause: error });
    }
    if (!response.ok) throw new SharePublishAuthorityError({ kind: "share-service-unavailable", origin });
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
  let nodePromise: Promise<TinyCloudNode> | undefined;
  let activeProfileName: string | undefined;
  const authenticatedNode = async () => nodePromise ??= (async () => {
    const profile = await profileName();
    activeProfileName = profile;
    const context = await ProfileManager.resolveContext({ profile, ...(input.nodeOrigin === undefined ? {} : { host: input.nodeOrigin }) });
    const { ensureAuthenticated } = await import("../lib/sdk.js");
    try {
      return await ensureAuthenticated(context);
    } catch (error) {
      const profileConfig = await ProfileManager.getProfile(profile).catch(() => undefined);
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (error instanceof InvalidRestoredSessionError || code === "AUTH_EXPIRED" || isSessionExpiredError(error)) {
        throw new SharePublishAuthorityError({
          kind: "owner-space-unresolved",
          localKey: profileConfig?.authMethod === "local",
          profileName: profile,
        });
      }
      throw error;
    }
  })();
  const assertDomainDeliveryForOrigin = async (nodeOrigin: string, operation: "publish" | "notify"): Promise<void> => {
    let response: Response;
    try {
      // Match sdk-core's /info request: redirects follow the authenticated Node origin.
      response = await fetchFn(`${nodeOrigin}/info`, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new SharePublishAuthorityError({ kind: "node-info-unavailable" });
    }
    if (!response.ok) throw new SharePublishAuthorityError({ kind: "node-info-unavailable" });
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new SharePublishAuthorityError({ kind: "node-info-unavailable" });
    }
    let info: unknown;
    try { info = JSON.parse(body); } catch { info = undefined; }
    const version = typeof info === "object" && info !== null && "version" in info ? info.version : undefined;
    if (!supportsDomainDelivery(version)) {
      throw new SharePublishAuthorityError({
        kind: "invalid-request",
        reason: `domain notifications require tinycloud-node ${MIN_DOMAIN_DELIVERY_VERSION} or later; node reports version ${displayedNodeVersion(version)}. Upgrade the node before inviting; ${operation === "publish" ? "nothing was shared and no invitation was sent" : "no invitation was sent"}`,
      });
    }
  };
  const assertDomainDelivery = async (): Promise<void> => {
    const node = await authenticatedNode();
    await assertDomainDeliveryForOrigin((await node.activeNodeIdentity()).origin, "notify");
  };
  const revokeRoot: NonNullable<ShareRevocationAdapter["revokePolicyRoot"]> = input.revokePolicyRoot ?? (async (request) => {
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
  });
  const targetAdapter: TargetPublishAdapter = { async publish(targetInput) {
    if (input.publishTarget !== undefined) return input.publishTarget(targetInput);
    // The Share config is fetched only after the local checks below, so a refusal makes no request.
    const node = await authenticatedNode();
    const session = node.restorableSession;
    const ownerSpaceId = session?.spaceId;
    const localKey = !node.isSessionOnly;
    let sessionExpiresAt: Date | undefined;
    try {
      sessionExpiresAt = node.isSessionOnly && session?.siwe ? extractSiweExpiration(session.siwe) : undefined;
    } catch {
      throw new SharePublishAuthorityError({ kind: "owner-space-unresolved", localKey, profileName: activeProfileName });
    }
    if (
      ownerSpaceId === undefined ||
      (node.isSessionOnly && (!session?.siwe || !session.signature || sessionExpiresAt === undefined))
    ) {
      throw new SharePublishAuthorityError({ kind: "owner-space-unresolved", localKey, profileName: activeProfileName });
    }
    if (node.isSessionOnly && sessionExpiresAt !== undefined) {
      const roundedSessionExpiry = new Date(Math.floor(sessionExpiresAt.getTime() / 1000) * 1000);
      if (roundedSessionExpiry.getTime() <= Date.now() + 60_000) {
        throw new SharePublishAuthorityError({
          kind: "lifetime-exceeds-session",
          sessionExpiresAt,
          reason: "session-too-close",
          localKey,
          profileName: activeProfileName,
        });
      }
    }
    const expiryClamped = node.isSessionOnly && sessionExpiresAt !== undefined && targetInput.expiresAt > sessionExpiresAt;
    if (expiryClamped && targetInput.expiryWasExplicit) {
      throw new SharePublishAuthorityError({
        kind: "lifetime-exceeds-session",
        sessionExpiresAt: sessionExpiresAt!,
        reason: "beyond-session",
        localKey,
        profileName: activeProfileName,
      });
    }
    const effectiveExpiry = expiryClamped ? sessionExpiresAt! : targetInput.expiresAt;
    const expiresAt = new Date(Math.floor(effectiveExpiry.getTime() / 1000) * 1000);
    if (expiresAt.getTime() <= Date.now() + 60_000) {
      throw new SharePublishAuthorityError({
        kind: "lifetime-exceeds-session",
        sessionExpiresAt: sessionExpiresAt ?? expiresAt,
        reason: node.isSessionOnly && expiryClamped && !targetInput.expiryWasExplicit
          ? "session-too-close"
          : "below-minimum",
        localKey,
        profileName: activeProfileName,
      });
    }
    // An addressed share's policy ceiling includes decrypt on the owner's encryption network, which a
    // session-only sign-in (e.g. builtin:share-publishing) deliberately lacks. Refuse before any Share
    // or node request, registry write or upload. A signer-backed (local-key) owner has full authority.
    if (targetInput.target.kind === "email" &&
        (targetInput.credentialDescriptor === undefined || targetInput.issuerDid === undefined || targetInput.issuerKid === undefined)) {
      throw new TypeError("email credential descriptor and issuer are required");
    }
    const addressedEncryptionNetwork = targetInput.target.kind === "bearer" ? undefined : targetInput.target.kind === "email"
      ? node.getDefaultEncryptionNetworkId() : node.getEncryptionNetworkIdForSpace(ownerSpaceId);
    const emailKeyPath = targetInput.target.kind === "email" ? `share/${crypto.randomUUID().replaceAll("-", "")}` : undefined;
    if (addressedEncryptionNetwork !== undefined && node.isSessionOnly && !sessionHoldsEncryptionDecrypt(node,
      emailKeyPath === undefined ? addressedEncryptionNetwork : `${addressedEncryptionNetwork}/${emailKeyPath}`)) {
      throw new SharePublishAuthorityError({ kind: "decrypt-not-held", profileName: activeProfileName });
    }
    const config = await publicConfig();
    if (targetInput.origin !== config.shareOrigin) throw new SharePublishAuthorityError({ kind: "origin-mismatch" });
    const activeNode = await node.activeNodeIdentity();
    if (targetInput.notify === true && targetInput.target.kind === "emailDomain") {
      await assertDomainDeliveryForOrigin(activeNode.origin, "publish");
    }
    const shareId = emailKeyPath?.slice("share/".length) ?? crypto.randomUUID().replaceAll("-", "");
    const files = targetInput.files === undefined || targetInput.files.length === 0
      ? [{ bytes: targetInput.source, filename: targetInput.filename, mediaType: targetInput.mediaType }]
      : targetInput.files;
    const resourceKind = targetInput.resourceKind ?? "exact";
    if (targetInput.target.kind === "bearer") {
      if (resourceKind !== "exact" || files.length !== 1) throw new Error("native bearer publication requires one exact source file");
      const file = files[0]!;
      const storageName = safeStorageFilename(targetInput.filename);
      const artifact = targetInput.artifact;
      // An artifact share is pinned to a write-once version, so its path is only known after the version is
      // claimed. The preflight below uses version 1 of the same artifact: every version shares one scope.
      let resourcePath = artifact === undefined
        ? `xyz.tinycloud.share/shares/${shareId}/${storageName}`
        : artifactVersionFilePath(artifact.id, 1, storageName);
      // A session-only profile can mint the link's delegation only from its
      // own uncaveated authority (no signer to fall back on). Check before
      // storing, so a refusal leaves no orphaned file. The request matches
      // createNativeShare's: kv/get on the exact path, until `expiresAt`.
      if (node.isSessionOnly) {
        const authority = node.sharing.preflightGenerate({ path: resourcePath, actions: ["tinycloud.kv/get"], expiry: expiresAt });
        if (authority === "caveated") {
          throw new SharePublishAuthorityError({ kind: "caveated-session", profileName: activeProfileName });
        }
        if (authority === "not-covered") {
          throw new SharePublishAuthorityError({ kind: "scope-denied", capability: "sharing delegation", localKey, profileName: activeProfileName });
        }
      }
      let artifactVersion: ArtifactVersionResult | undefined;
      if (artifact !== undefined) {
        artifactVersion = await storeArtifactVersion(node.kvForSpace(ownerSpaceId), {
          artifactId: artifact.id,
          files: [{ filename: storageName, bytes: file.bytes, contentType: targetInput.mediaType ?? file.mediaType ?? "application/octet-stream" }],
          ...(artifact.note === undefined ? {} : { note: artifact.note }),
        }, { localKey, profileName: activeProfileName });
        resourcePath = artifactVersionFilePath(artifact.id, artifactVersion.version, storageName);
      } else {
        const written = await node.kvForSpace(ownerSpaceId).put(resourcePath, file.bytes.slice(), {
          contentType: targetInput.mediaType ?? file.mediaType ?? "application/octet-stream",
        });
        failIfSpaceNotReady(written);
        if (!written.ok) {
          const code = typeof written.error === "object" && written.error !== null && "code" in written.error ? written.error.code : undefined;
          if (code === "AUTH_UNAUTHORIZED" || code === "PERMISSION_DENIED") {
            const requiredAction = requiredKvAction(written.error.meta);
            throw new SharePublishAuthorityError({
              kind: "scope-denied",
              capability: "KV upload",
              ...(requiredAction === undefined ? {} : { requiredAction }),
              localKey,
              profileName: activeProfileName,
            });
          }
          throwKvUploadFailure(written.error);
        }
      }
      let native: NativeShareResult;
      try {
        native = await createNativeShare(node.sharing, {
          path: resourcePath,
          expiresAt,
          viewerOrigin: config.shareOrigin,
        });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "AUTH_UNAUTHORIZED" || code === "PERMISSION_DENIED") {
          throw new SharePublishAuthorityError({
            kind: "scope-denied",
            capability: "sharing delegation",
            localKey,
            profileName: activeProfileName,
          });
        }
        throw error;
      }
      if (native.spaceId !== ownerSpaceId) throw new Error("native bearer delegation authority does not match the authenticated owner space");
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
          ...(expiryClamped ? { expiryClamped: true } : {}),
          expiresAt: native.expiresAt.toISOString(),
          display: { filename: targetInput.filename },
          recipientMatcher: { kind: "bearer" as const },
          enforcementDelegationCid: native.delegationCid,
          ...(artifact !== undefined && artifactVersion !== undefined ? { artifact: { id: artifact.id, version: artifactVersion.version, mode: "pinned" as const } } : {}),
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
    const storageName = safeStorageFilename(targetInput.filename);
    const artifact = targetInput.artifact;
    // A pinned artifact share reads one write-once version file, so its path is only known after the version is claimed.
    let resourcePath = artifact === undefined ? `shares/${shareId}/${storageName}` : artifactVersionFilePath(artifact.id, 1, storageName);
    const byteLength = file.bytes.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > 100 * 1024 * 1024) throw new Error("addressed publication exceeds the combined byte limit");
    const mediaType = targetInput.mediaType ?? file.mediaType ?? "application/octet-stream";
    const actions = targetInput.actions === undefined || targetInput.actions.length === 0 ? ["read"] as const : targetInput.actions;
    const policyActions = [...new Set(actions.flatMap((action) => action === "read" ? ["tinycloud.kv/get", "tinycloud.kv/metadata"] : action === "list" ? ["tinycloud.kv/list"] : ["tinycloud.kv/put"]))] as ("tinycloud.kv/get" | "tinycloud.kv/list" | "tinycloud.kv/metadata" | "tinycloud.kv/put")[];
    // A pinned path is immutable: it never carries `put`. v1 artifact shares are pinned-only; ongoing shares wait for link-as-delegation.
    if (artifact !== undefined && policyActions.includes("tinycloud.kv/put")) {
      throw new SharePublishAuthorityError({ kind: "invalid-request", reason: "a pinned artifact share cannot grant edit" });
    }
    // Refuse a bad target, recipient, filename or action set before anything
    // is published or uploaded. This also canonicalizes the recipient and
    // derives the credential commitment mailbox recipients open the share
    // with; without it the SDK would sign a Policy/v1 share no receiver opens.
    let prepared: PreparedAddressedShare;
    try {
      prepared = prepareAddressedShare({ target: targetInput.target, actions, policyActions, filename: targetInput.filename });
    } catch (error) {
      throw new SharePublishAuthorityError({ kind: "invalid-request", reason: error instanceof TypeError ? error.message : "addressed share request is invalid" });
    }
    const deliveryEmail = prepared.target.kind === "email" && isEnvelopeDeliveryEmail(prepared.target.address) ? prepared.target.address : undefined;
    // A link carries at most MAX_LINK_BODY_BYTES of sealed envelope. Measure the largest this share's envelope can be, from
    // its own inputs, before the first write (registry record, upload, policy registration): a share over the limit stops here.
    await assertAddressedShareFits({
      shareId,
      ownerDid: node.credentialHolderDid,
      nodeOrigin: activeNode.origin,
      nodeAudience: activeNode.nodeDid,
      enforcerDid: activeNode.nodeDid,
      spaceId: ownerSpaceId,
      target: prepared.target,
      resource: { kind: resourceKind },
      storage: artifact === undefined ? { path: resourcePath } : { artifactId: artifact.id, storageName },
      encryptionNetwork: addressedEncryptionNetwork!,
      ...(emailKeyPath === undefined ? {} : { encryptionKeyPath: emailKeyPath }),
      actions,
      policyActions,
      ...(deliveryEmail === undefined ? {} : { deliveryEmail }),
      filename: targetInput.filename,
      mediaType,
      byteLength,
      expiresAt,
    });
    // Receivers find the owner's node through a registry record signed by the
    // policy owner (this session key). Publish it before storing content so a
    // registry failure cannot leave an orphaned object or an unverifiable link.
    try {
      await node.publishActiveNodeLocation(config.registryOrigin, fetchFn);
    } catch (error) {
      // An unreachable or failing registry (network error, 5xx, 408, 429) may
      // recover; a refused or invalid record will not, so don't suggest a retry.
      const rejected = error instanceof LocationRecordValidationError
        || (error instanceof LocationRegistryHttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429);
      throw new SharePublishAuthorityError({ kind: rejected ? "registry-rejected" : "registry-unavailable" });
    }
    const encryptionNetwork = addressedEncryptionNetwork!;
    const encrypted = await node.encryption.encryptToNetwork(encryptionNetwork, file.bytes, {
      ...(emailKeyPath === undefined ? {} : { keyPath: emailKeyPath }),
      metadata: { contentType: mediaType },
    });
    if (!encrypted.ok) throw new Error("addressed source encryption was rejected");
    if (emailKeyPath !== undefined && (encrypted.data.networkId !== encryptionNetwork || encrypted.data.keyPath !== emailKeyPath)) {
      throw new Error("email share encryption was rejected");
    }
    const storedBytes = new TextEncoder().encode(canonicalize(encrypted.data as unknown as Record<string, unknown>));
    let artifactVersion: ArtifactVersionResult | undefined;
    if (artifact !== undefined) {
      // The manifest records the digest of these stored bytes (ciphertext) only: a hash of the plaintext would sit
      // in the owner's space next to the ciphertext and let a reader confirm a guessed plaintext. Every encryption
      // is a fresh random key, so each addressed publish is its own version.
      artifactVersion = await storeArtifactVersion(node.kvForSpace(ownerSpaceId), {
        artifactId: artifact.id,
        files: [{ filename: storageName, bytes: storedBytes, contentType: "application/vnd.tinycloud.encrypted-envelope+json" }],
        ...(artifact.note === undefined ? {} : { note: artifact.note }),
      }, { localKey, profileName: activeProfileName });
      resourcePath = artifactVersionFilePath(artifact.id, artifactVersion.version, storageName);
    } else {
      const stored = await node.kvForSpace(ownerSpaceId).put(resourcePath, storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
      failIfSpaceNotReady(stored);
      if (!stored.ok) {
        const code = typeof stored.error === "object" && stored.error !== null && "code" in stored.error ? stored.error.code : undefined;
        if (code === "AUTH_UNAUTHORIZED" || code === "PERMISSION_DENIED") {
          const requiredAction = requiredKvAction(stored.error.meta);
          throw new SharePublishAuthorityError({
            kind: "scope-denied",
            capability: "KV upload",
            ...(requiredAction === undefined ? {} : { requiredAction }),
            localKey,
            profileName: activeProfileName,
          });
        }
        throwKvUploadFailure(stored.error);
      }
    }
    const contentSource = {
      shareId,
      kvResource: `${ownerSpaceId}/kv/${resourcePath}`,
      selector: resourceKind,
      encryptionNetwork: encrypted.data.networkId,
      ...(emailKeyPath === undefined ? {} : { encryptionKeyPath: emailKeyPath }),
      encryptedSymmetricKeyDigestHex: encrypted.data.encryptedSymmetricKeyHash,
      keyVersion: encrypted.data.keyVersion,
      mode: "immutable" as const,
      initialCiphertextDigestHex: createHash("sha256").update(storedBytes).digest("hex"),
    };
    const addressedOptions: AddressedSharePublishOptions = {
      shareId,
      shareOrigin: config.shareOrigin,
      nodeOrigin: activeNode.origin,
      nodeAudience: activeNode.nodeDid,
      enforcerDid: activeNode.nodeDid,
      spaceId: ownerSpaceId,
      target: prepared.target,
      resource: { kind: resourceKind, path: resourcePath },
      actions,
      policyActions,
      contentSource,
      // The owner-signed pin: artifact id, version, manifest digest and the digest of the stored ciphertext this share reads.
      ...(artifactVersion === undefined ? {} : { artifactPin: buildArtifactPin(artifactVersion, storageName) }),
      ...(prepared.credentialRequirement === undefined ? {} : { credentialRequirement: prepared.credentialRequirement }),
      // tinycloud-node 1.17.2 signs a delivery receipt only for the envelope's
      // own signed delivery address (1.17.3 accepts it and no longer requires
      // it), so an exact-email share pins its canonical mailbox for `--notify`
      // and `tc share notify`. A mailbox the envelope's `deliveryEmail` rule
      // rejects (deployed viewers validate with it) is published unpinned.
      ...(deliveryEmail === undefined ? {} : { deliveryEmail }),
      filename: targetInput.filename,
      mediaType,
      byteLength,
      expiresAt,
      // App-neutral owner authority: the Node SDK owns every Policy/v3
      // transport hop, so the CLI supplies only owner signing material.
      authority: {
        ownerDid: node.credentialHolderDid,
        createOwnerRoot: (request) => node.createUnifiedOwnerRoot(request),
        sign: (bytes) => node.signSessionBytes(bytes),
        registerPolicy: (request) => node.registerPolicy(request),
      },
    };
    let published: PublishedShare;
    try {
      published = prepared.target.kind === "email"
        ? await publishEmailShareV3({ ...addressedOptions, target: prepared.target,
          credentialDescriptor: targetInput.credentialDescriptor,
          issuerDid: targetInput.issuerDid!, issuerKid: targetInput.issuerKid! })
        : await publishAddressedShare(addressedOptions);
    } catch (error) {
      if (!(error instanceof AddressedShareOverLimitError)) throw error;
      // The sealed envelope was over the limit although the bound said it fit: nothing was linked. Remove what was written.
      const remaining = await removeOverLimitShare({
        written: error.written,
        revokeRoot,
        owner: { ownerDid: node.credentialHolderDid, nodeOrigin: activeNode.origin, nodeAudience: activeNode.nodeDid },
        content: artifactVersion === undefined
          ? {
              kind: "object",
              path: resourcePath,
              remove: async () => {
                const removed = await node.kvForSpace(ownerSpaceId).delete(resourcePath);
                const code = !removed.ok && typeof removed.error === "object" && removed.error !== null && "code" in removed.error ? removed.error.code : undefined;
                if (!removed.ok && code !== "KV_NOT_FOUND") throw new Error("uploaded content could not be deleted");
              },
            }
          : { kind: "artifact", id: artifactVersion.artifactId, version: artifactVersion.version },
      });
      throw new SharePublishAuthorityError({ kind: "over-limit", remaining }, { cause: error });
    }
    if (expiryClamped) Object.defineProperty(published.metadata, "expiryClamped", { value: true, enumerable: true });
    if (artifact !== undefined && artifactVersion !== undefined) {
      Object.defineProperty(published.metadata, "artifact", { value: { id: artifact.id, version: artifactVersion.version, mode: "pinned" as const }, enumerable: true });
    }
    return published;
  } };
  const delivery: ShareDeliveryAdapter = { deliver: input.deliver ?? (async (request) => {
    const record = request.record;
    if (
      record === undefined
      || record.link === undefined
      || record.deliveryMaterial === undefined
      || request.idempotencyKey === undefined
    ) throw new Error("share delivery history is incomplete");
    // Bind the JTI to a process-stable body for the full Node retry window.
    // `registeredAt` is persisted before notification starts, so a recreated
    // adapter derives the same expiry without retaining unbounded local state.
    const expiry = shareDeliveryWindowExpiresAt(record);
    if (expiry <= Date.now()) throw new ShareNotifyError("share delivery authorization window has expired", "delivery-window-expired");
    const authorizationExpiresAt = new Date(expiry).toISOString();
    const [config, node] = await Promise.all([publicConfig(), authenticatedNode()]);
    const receipt = await node.authorizeShareDeliveryV3({
      envelope: record.deliveryMaterial.envelope as Parameters<typeof node.authorizeShareDeliveryV3>[0]["envelope"],
      resourcePath: record.resource.path,
      recipientEmail: request.recipient,
      shareUrl: record.link,
      documentName: record.filename ?? "share.md",
      expiresAt: authorizationExpiresAt,
      deliveryAudience: config.credentialsOrigin,
      idempotencyKey: request.idempotencyKey,
      trustedOrigins: [config.shareOrigin],
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
    // The node authorizes a revocation signed by the delegation's delegator,
    // or by the owner of a space it targets. A bearer link is minted by the
    // session key, or by the owner wallet when it outlives the session, so a
    // proofless session-key revocation covers the first, and a local owner
    // key covers both. Without either key (a session-only profile that signed
    // in again since, for example) the link cannot be revoked here.
    revokeDelegation: input.revokeDelegation ?? (async ({ delegationCid, record }) => {
      const node = await authenticatedNode();
      const activeNode = await node.activeNodeIdentity();
      if (record.target.origin !== activeNode.origin) throw new Error("share delegation revocation is not bound to the active owner node");
      // Revoke only the delegation the stored link carries: signed, bound to
      // the record's CID by its exact bytes, delegated to the link's own key
      // for the record's resource, and never this profile's session.
      // Exit codes follow `tc share`: 4 unavailable (ExitCode.NOT_FOUND), 5 permission denied, 1 check node state before retrying.
      const linkUnavailable = new CLIError("SHARE_LINK_UNAVAILABLE", "this share's stored link could not be verified; nothing was revoked", ExitCode.NOT_FOUND);
      const resource = `${record.target.spaceId}/kv/${record.resource.path}`;
      let sessionIssued: boolean;
      try {
        const decoded = node.sharing.decodeLink(parseNativeShareUrl(record.link ?? ""));
        const linkKey = decoded.keyDid.split("#", 1)[0];
        const authorization = withoutBearer(decoded.delegation.authHeader ?? "");
        if (authorization.split(".").length === 3) {
          const signed = parseSignedCompactUcanAttenuation(authorization, delegationCid);
          if (signed.payload.aud.split("#", 1)[0] !== linkKey || signed.payload.att[resource] === undefined) throw linkUnavailable;
          sessionIssued = signed.payload.iss.split("#", 1)[0] === node.credentialHolderDid;
        } else {
          // A link that outlives the session carries the owner wallet's CACAO.
          const signed = await parseSignedSiweCacao(authorization, delegationCid);
          const owner = /^tinycloud:pkh:(eip155:[1-9]\d*:0x[0-9a-fA-F]{40}):/.exec(record.target.spaceId)?.[1];
          if (owner === undefined || signed.issuer.toLowerCase() !== `did:pkh:${owner}`.toLowerCase() || signed.audience !== linkKey || signed.attenuation[resource] === undefined) throw linkUnavailable;
          sessionIssued = false;
        }
      } catch {
        throw linkUnavailable;
      }
      if (delegationCid === node.session?.delegationCid) throw linkUnavailable;
      let authorization: string;
      if (sessionIssued) {
        const now = Math.floor(Date.now() / 1000);
        authorization = (await signCompactUcanAuthorization({
          issuerDid: node.sessionDid,
          audienceDid: activeNode.nodeDid,
          attenuation: { [`urn:cid:${delegationCid}`]: { "tinycloud.delegation/revoke": [{}] } },
          facts: [{}],
          proofs: [],
          notBefore: now,
          expiresAt: now + 60,
          nonce: `urn:uuid:${crypto.randomUUID()}`,
          sign: (bytes) => node.signSessionBytes(bytes),
        })).authorization;
      } else if (!node.isSessionOnly) {
        authorization = await node.signOwnerRevocation(delegationCid);
      } else {
        throw new CLIError("SHARE_ISSUER_KEY_UNAVAILABLE", "the key that created this share link is not available to this profile; nothing was revoked", ExitCode.PERMISSION_DENIED);
      }
      const response = await fetchFn(`${activeNode.origin}/revoke`, { method: "POST", headers: { Authorization: authorization } });
      const body = await response.text();
      if (response.ok) {
        let receipt: unknown;
        try { receipt = JSON.parse(body); } catch { receipt = undefined; }
        if (typeof receipt === "object" && receipt !== null && "revoked" in receipt && receipt.revoked === true && "cid" in receipt && receipt.cid === delegationCid) return;
        throw new CLIError(
          "SHARE_REVOKE_UNCONFIRMED",
          `the node answered the share revocation with HTTP ${response.status} but did not confirm it; the link may already be revoked. Check whether it still opens before retrying`,
          ExitCode.ERROR,
          { status: response.status },
        );
      }
      // The node's /revoke error text is a fixed reason such as "Unauthorized Revoker".
      const nodeMessage = body.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
      throw new CLIError(
        "SHARE_REVOKE_REJECTED",
        `the node rejected the share revocation (HTTP ${response.status}${nodeMessage === "" ? "" : `: ${nodeMessage}`}); nothing was revoked`,
        ExitCode.NOT_FOUND,
        { status: response.status },
      );
    }),
    revokePolicyRoot: revokeRoot,
  };
  const nativeReader = async (link: string): Promise<{ readonly bytes: Uint8Array; readonly filename: string }> => {
    const { TinyCloudNode } = await import("@tinycloud/node-sdk");
    const sharing = input.nativeSharing ?? ((host: string | undefined) => new TinyCloudNode({ ...(host === undefined ? {} : { host }), autoDiscoverLocalNode: false }).sharing);
    const token = parseNativeShareUrl(link);
    const decoded = sharing(undefined).decodeLink(token) as { readonly host?: unknown };
    if (typeof decoded.host !== "string") throw new Error("native share has no owner Node");
    const received = await sharing(canonicalOrigin(decoded.host, "owner node origin")).receive(token, { autoSubdelegate: false, useSessionKey: false });
    const value = received.ok ? await received.data.kv.get<Uint8Array>("", { binary: true }) : undefined;
    // The owner Node answers a revoked link's read with `401 - delegation-revoked: <cid>`.
    const failure = !received.ok ? received.error : value !== undefined && !value.ok ? value.error : undefined;
    if (failure?.meta?.status === 401 && /: 401 - (?:Invalid invocation: )?delegation-revoked: [A-Za-z0-9]+\s*$/.test(failure.message)) {
      throw new CLIError("SHARE_REVOKED", "This share link has been revoked by its sender.", ExitCode.NOT_FOUND);
    }
    if (!received.ok) throw new Error("native share could not be verified");
    if (value === undefined || !value.ok || !(value.data.data instanceof Uint8Array)) throw new Error("native share content could not be read");
    return { bytes: value.data.data.slice(), filename: received.data.path.split("/").at(-1) || "share.md" };
  };
  const artifactStore = async (): Promise<ArtifactStore> => {
    const node = await authenticatedNode();
    const spaceId = node.restorableSession?.spaceId;
    if (spaceId === undefined) throw new SharePublishAuthorityError({ kind: "owner-space-unresolved", localKey: !node.isSessionOnly, profileName: activeProfileName });
    const store = kvArtifactStore(node.kvForSpace(spaceId));
    const authority = { localKey: !node.isSessionOnly, profileName: activeProfileName };
    // A profile signed in before the `artifacts/` scope existed is refused by the node; say so the way publish does.
    const mapped = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); }
      catch (error) { throw scopeDeniedFromArtifactError(error, "artifact storage", authority) ?? artifactSpaceNotReady(error); }
    };
    return {
      put: (key, bytes, options) => mapped(() => store.put(key, bytes, options)),
      get: (key) => mapped(() => store.get(key)),
      list: (prefix) => mapped(() => store.list(prefix)),
    };
  };
  const links = createShareLinks({
    signer: async () => {
      const node = await authenticatedNode();
      return { did: node.credentialHolderDid, sign: (digest) => node.signSessionBytes(digest) };
    },
    fetchFn,
  });
  return {
    targetAdapter,
    records: input.profileName === undefined ? createEncryptedSessionHistory() : createEncryptedProfileHistory(profileName, signShareHistoryBytes),
    delivery,
    revocation,
    assertDomainDelivery,
    nativeReader,
    artifactStore,
    links,
  };
}

async function selectedProfileName(): Promise<string> {
  const config = await ProfileManager.getConfig();
  return process.env.TC_PROFILE ?? config.defaultProfile;
}
