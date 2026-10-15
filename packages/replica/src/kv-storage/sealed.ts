import { bytesToHex } from "@noble/hashes/utils";

import { ReplicaError, ReplicaErrorCode } from "../errors.js";

/** v1 AES-256-GCM record: 96-bit fresh random IV per write, 128-bit tag; the account gate owns the nonextractable CryptoKey. */
export type SealedRecord = { v: 1; iv: Uint8Array; bytes: Uint8Array };

const encoder = new TextEncoder();
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

/** AAD binds format version, store, partition and row id; the caller supplies an unambiguous context. */
function aad(context: string): Uint8Array {
  return encoder.encode(`tinycloud-replica-kv:v1\u0000${context}`);
}

export async function seal(key: CryptoKey, plaintext: Uint8Array, context: string): Promise<SealedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const bytes = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(context) }, key, plaintext,
  ));
  return { v: 1, iv, bytes };
}

export async function openSealed(key: CryptoKey, record: unknown, context: string): Promise<Uint8Array> {
  if (record === null || typeof record !== "object" || !("v" in record) || record.v !== 1
    || !("iv" in record) || !(record.iv instanceof Uint8Array) || record.iv.length !== NONCE_LENGTH
    || !("bytes" in record) || !(record.bytes instanceof Uint8Array) || record.bytes.length < TAG_LENGTH) {
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica record is unsealed or has an unknown ciphertext version.");
  }
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv, additionalData: aad(context) }, key, record.bytes,
    ));
  } catch (cause) {
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica record failed authentication.", undefined, { cause });
  }
}

/** A private, deterministic primary key. The gate's public salt never enters this derivation. */
export async function opaqueId(key: CryptoKey, store: string, partition: string, value: string): Promise<string> {
  const input = encoder.encode(JSON.stringify(["tinycloud-replica-kv", 1, store, partition, value]));
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, input)));
}

/** Count the canonical UTF-8 encoding without allocating an encoded copy of a stored value. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
      && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

type MeasuredRow = Partial<SealedRecord> & {
  pid?: string;
  hashId?: string;
  size?: number;
  revision?: number;
  generation?: number;
  coverageCode?: number;
  syncedThroughEpoch?: number;
  keys?: number;
  contentMissing?: number;
  tombstones?: number;
  contentBytes?: number;
  purged?: boolean;
};

/** Canonical application-encoded bytes for the final persisted row, not IDB engine allocation. */
export function measureSealedRow(key: IDBValidKey, row: MeasuredRow): number {
  if (row.purged === true
    ? row.v !== undefined || row.iv !== undefined || row.bytes !== undefined
    : row.v !== 1 || !(row.iv instanceof Uint8Array) || !(row.bytes instanceof Uint8Array)) {
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica row has an invalid sealed envelope.");
  }
  const primaryKey = JSON.stringify(key);
  if (typeof primaryKey !== "string") {
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica row has an invalid primary key.");
  }
  let total = 2 + 4 + utf8Length(primaryKey);
  let hasSize = false;
  for (const name in row) {
    if (!Object.hasOwn(row, name)) continue;
    const value: unknown = Reflect.get(row, name);
    total += 1 + name.length; // All persisted field names below are ASCII.
    switch (name) {
      case "pid":
      case "hashId":
        if (typeof value !== "string") throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica row has an invalid identifier.");
        total += 4 + utf8Length(value);
        break;
      case "v":
        if (value !== 1) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica row has an unknown version.");
        total += 1;
        break;
      case "coverageCode":
        if (value !== 0 && value !== 1 && value !== 2) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica row has invalid coverage.");
        total += 1;
        break;
      case "purged":
        if (typeof value !== "boolean") throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica row has invalid purge state.");
        total += 1;
        break;
      case "revision":
      case "generation":
      case "syncedThroughEpoch":
      case "keys":
      case "contentMissing":
      case "tombstones":
      case "contentBytes":
      case "size":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica row has an invalid numeric field.");
        }
        if (name === "size") hasSize = true;
        total += 8;
        break;
      case "iv":
      case "bytes":
        if (!(value instanceof Uint8Array)) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica row has invalid ciphertext.");
        total += 4 + value.byteLength;
        break;
      default:
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica row has an unknown persisted field.");
    }
  }
  if (!hasSize) total += 1 + "size".length + 8;
  return total;
}
