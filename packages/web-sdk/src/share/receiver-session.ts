import { didKeyFromEd25519PublicKey, fromBase64Url } from "@tinycloud/share-envelope";

export const SHARE_RECEIVER_SESSION_STORAGE_KEY = "tinycloud.share.receiver-session.v1";

const KEY_COHERENCE_PROBE = new TextEncoder().encode("tinycloud.share.receiver-session/v1");

export interface ShareReceiverSessionRecordV1 {
  readonly type: "TinyCloudShareReceiverSession";
  readonly version: 1;
  readonly origin: string;
  readonly holderDid: string;
  readonly jwk: JsonWebKey;
  readonly createdAt: string;
}

export interface ReceiverSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ShareReceiverSession {
  readonly holderDid: string;
  readonly origin: string;
  readonly createdAt: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonicalReceiverOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("receiver origin is invalid"); }
  const loopbackHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((url.protocol !== "https:" && !loopbackHttp) || url.origin !== value) throw new Error("receiver origin must be canonical HTTPS or explicit loopback HTTP");
  return value;
}

function normalizedJwk(value: unknown): JsonWebKey | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const jwk = value as Record<string, unknown>;
  if (!exactKeys(jwk, ["kty", "crv", "x", "d"]) || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string") return undefined;
  try {
    if (fromBase64Url(jwk.x).length !== 32 || fromBase64Url(jwk.d).length !== 32) return undefined;
  } catch { return undefined; }
  return Object.freeze({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d });
}

function validateRecord(value: unknown, origin: string): ShareReceiverSessionRecordV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, ["type", "version", "origin", "holderDid", "jwk", "createdAt"]) || item.type !== "TinyCloudShareReceiverSession" || item.version !== 1 || item.origin !== origin || typeof item.holderDid !== "string" || typeof item.createdAt !== "string") return undefined;
  const createdAt = Date.parse(item.createdAt);
  if (!Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== item.createdAt) return undefined;
  const jwk = normalizedJwk(item.jwk);
  if (jwk === undefined || didKeyFromEd25519PublicKey(fromBase64Url(jwk.x!)) !== item.holderDid) return undefined;
  return Object.freeze({ type: "TinyCloudShareReceiverSession", version: 1, origin, holderDid: item.holderDid, jwk, createdAt: item.createdAt });
}

async function usable(record: ShareReceiverSessionRecordV1): Promise<ShareReceiverSession> {
  const privateKey = await crypto.subtle.importKey("jwk", record.jwk, { name: "Ed25519" }, false, ["sign"]);
  const publicKey = await crypto.subtle.importKey("jwk", {
    kty: "OKP",
    crv: "Ed25519",
    x: record.jwk.x,
  }, { name: "Ed25519" }, false, ["verify"]);
  const probeSignature = await crypto.subtle.sign("Ed25519", privateKey, KEY_COHERENCE_PROBE);
  if (!await crypto.subtle.verify("Ed25519", publicKey, probeSignature, KEY_COHERENCE_PROBE)) throw new Error("receiver Ed25519 key material is inconsistent");
  return Object.freeze({
    holderDid: record.holderDid,
    origin: record.origin,
    createdAt: record.createdAt,
    sign: async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, bytes)),
  });
}

export async function createOrRestoreShareReceiverSession(
  originValue: string,
  storage: ReceiverSessionStorage = window.sessionStorage,
): Promise<ShareReceiverSession> {
  const origin = canonicalReceiverOrigin(originValue);
  const saved = storage.getItem(SHARE_RECEIVER_SESSION_STORAGE_KEY);
  if (saved !== null) {
    try {
      const record = validateRecord(JSON.parse(saved), origin);
      if (record !== undefined) return await usable(record);
    } catch { /* replace corrupt or unusable key material below */ }
    storage.removeItem(SHARE_RECEIVER_SESSION_STORAGE_KEY);
  }
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const jwk = normalizedJwk({ kty: exported.kty, crv: exported.crv, x: exported.x, d: exported.d });
  if (jwk === undefined) throw new Error("receiver Ed25519 key generation failed");
  const record: ShareReceiverSessionRecordV1 = Object.freeze({
    type: "TinyCloudShareReceiverSession",
    version: 1,
    origin,
    holderDid: didKeyFromEd25519PublicKey(fromBase64Url(jwk.x!)),
    jwk,
    createdAt: new Date().toISOString(),
  });
  storage.setItem(SHARE_RECEIVER_SESSION_STORAGE_KEY, JSON.stringify(record));
  return usable(record);
}
