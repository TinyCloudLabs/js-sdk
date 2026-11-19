import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

import { ReplicaError, ReplicaErrorCode } from "../errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HASH_BYTES = 64;

/** Typed arrays and user objects occupy different wire variants, even when a user key resembles a marker. */
function encodeValue(value: unknown): unknown {
  if (value === undefined) return ["undefined"];
  if (value instanceof Uint8Array) return ["bytes", bytesToHex(value)];
  if (Array.isArray(value)) return ["array", value.map(encodeValue)];
  if (value !== null && typeof value === "object") {
    return ["object", Object.entries(value).map(([key, item]) => [key, encodeValue(item)])];
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "A replica record contains a non-finite number.");
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "A replica record contains an unsupported value.");
}

function decodeValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (!Array.isArray(value) || typeof value[0] !== "string") throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica record has an invalid payload variant.");
  if (value[0] === "undefined" && value.length === 1) return undefined;
  if (value[0] === "bytes" && value.length === 2 && typeof value[1] === "string" && /^(?:[0-9a-f]{2})*$/.test(value[1])) return hexToBytes(value[1]);
  if (value[0] === "array" && value.length === 2 && Array.isArray(value[1])) return value[1].map(decodeValue);
  if (value[0] === "object" && value.length === 2 && Array.isArray(value[1])) {
    const seen = new Set<string>();
    const fields: Array<[string, unknown]> = [];
    for (const pair of value[1]) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || seen.has(pair[0])) {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica record has an invalid object field.");
      }
      seen.add(pair[0]);
      fields.push([pair[0], decodeValue(pair[1])]);
    }
    return Object.fromEntries(fields);
  }
  throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica record has an invalid payload variant.");
}

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(["tinycloud-replica-kv", 1, encodeValue(value)]));
}

export function decodeJson<T>(bytes: Uint8Array): T {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== "tinycloud-replica-kv" || value[1] !== 1) {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica record has an unknown payload version.");
    }
    return decodeValue(value[2]) as T;
  } catch (cause) {
    if (cause instanceof ReplicaError) throw cause;
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica record payload is corrupt.", undefined, { cause });
  }
}

/** Binds the original content hash inside authenticated plaintext, not just to its opaque IDB key. */
export function encodeBlob(hash: string, bytes: Uint8Array): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "Invalid content hash in the replica record.");
  const content = new Uint8Array(HASH_BYTES + bytes.length);
  content.set(encoder.encode(hash));
  content.set(bytes, HASH_BYTES);
  return content;
}

export function decodeBlob(content: Uint8Array): { hash: string; bytes: Uint8Array } {
  if (content.length < HASH_BYTES) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica content record is truncated.");
  const hash = decoder.decode(content.subarray(0, HASH_BYTES));
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "Invalid content hash in the replica record.");
  return { hash, bytes: content.subarray(HASH_BYTES) };
}
