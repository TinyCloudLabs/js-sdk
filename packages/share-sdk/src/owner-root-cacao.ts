import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { fromBase64Url } from "@tinycloud/share-envelope";

/**
 * The fields of an owner-signed SIWE CACAO that bound its authority. Read
 * from the exact bytes the Node imported; nothing here is taken from the
 * SDK's own echo of the request.
 */
export interface DecodedOwnerRootCacao {
  /** CIDv1 (raw, BLAKE3) of the exact CACAO bytes, as the Node computes it. */
  readonly cid: string;
  readonly issuer: string;
  readonly audience: string;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly notBefore?: string;
  /** Every SIWE resource, in signed order. */
  readonly resources: readonly string[];
  /** The ReCap `att` of the last resource; null-prototype maps. */
  readonly attenuation: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;
  /** The ReCap `prf` list (parent capabilities); a root has none. */
  readonly reCapProofs: readonly unknown[];
}

const MAX_CACAO_BYTES = 64 * 1024;
const MAX_CBOR_DEPTH = 64;
const RECAP_PREFIX = "urn:recap:";
type CborMap = Record<string, unknown>;

/**
 * Strict decoder for the DAG-CBOR subset a CACAO uses (the same subset and
 * limits as sdk-core's `parseSignedSiweCacao`): definite lengths, string map
 * keys without duplicates, no tags, floats or trailing bytes.
 */
function decodeDagCbor(bytes: Uint8Array): unknown {
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const take = (length: number): Uint8Array => {
    if (length > bytes.length - offset) throw new Error("CBOR input ended early");
    return bytes.subarray(offset, offset += length);
  };
  const read = (depth: number): unknown => {
    if (depth > MAX_CBOR_DEPTH) throw new Error("CBOR nesting is too deep");
    const initial = take(1)[0]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("CBOR simple value is not part of a CACAO");
    }
    if (major === 6) throw new Error("CBOR tags are not part of a CACAO");
    let argument: number;
    if (info < 24) argument = info;
    else if (info === 24) argument = take(1)[0]!;
    else if (info === 25) argument = view.getUint16(take(2).byteOffset - bytes.byteOffset);
    else if (info === 26) argument = view.getUint32(take(4).byteOffset - bytes.byteOffset);
    else throw new Error("CBOR length is unsupported");
    switch (major) {
      case 0: return argument;
      case 1: return -1 - argument;
      case 2: return take(argument).slice();
      case 3: return new TextDecoder("utf-8", { fatal: true }).decode(take(argument));
      case 4: {
        if (argument > bytes.length - offset) throw new Error("CBOR input ended early");
        const items: unknown[] = [];
        for (let index = 0; index < argument; index++) items.push(read(depth + 1));
        return items;
      }
      default: {
        if (argument > bytes.length - offset) throw new Error("CBOR input ended early");
        const map: CborMap = Object.create(null);
        for (let index = 0; index < argument; index++) {
          const key = read(depth + 1);
          if (typeof key !== "string" || key === "__proto__" || Object.prototype.hasOwnProperty.call(map, key)) throw new Error("CBOR map key is invalid");
          map[key] = read(depth + 1);
        }
        return map;
      }
    }
  };
  const value = read(0);
  if (offset !== bytes.length) throw new Error("CBOR input has trailing bytes");
  return value;
}

function map(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): CborMap {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Uint8Array) throw new Error(`CACAO ${label} must be a map`);
  const entries = value as CborMap;
  for (const key of Object.keys(entries)) if (!required.includes(key) && !optional.includes(key)) throw new Error(`CACAO ${label} has an unknown field`);
  for (const key of required) if (!(key in entries)) throw new Error(`CACAO ${label} is missing ${key}`);
  return entries;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`CACAO ${label} must be a non-empty string`);
  return value;
}

function reCap(resource: string): { attenuation: DecodedOwnerRootCacao["attenuation"]; proofs: readonly unknown[] } {
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(resource.slice(RECAP_PREFIX.length))));
  if (!isObject(parsed) || !isObject(parsed.att)) throw new Error("ReCap attenuation must be an object");
  for (const key of Object.keys(parsed)) if (key !== "att" && key !== "prf") throw new Error("ReCap has an unknown field");
  const proofs = parsed.prf ?? [];
  if (!Array.isArray(proofs)) throw new Error("ReCap prf must be an array");
  const attenuation: Record<string, Record<string, readonly unknown[]>> = Object.create(null);
  for (const [target, abilities] of Object.entries(parsed.att)) {
    if (target === "__proto__" || !isObject(abilities)) throw new Error("ReCap resource must map to abilities");
    const copy: Record<string, readonly unknown[]> = Object.create(null);
    for (const [ability, caveats] of Object.entries(abilities)) {
      if (ability === "__proto__" || !Array.isArray(caveats)) throw new Error("ReCap ability is invalid");
      copy[ability] = caveats;
    }
    attenuation[target] = copy;
  }
  return { attenuation, proofs };
}

/**
 * Decode the exact bytes of an owner-signed SIWE CACAO. Checks size, CBOR
 * strictness, the envelope shape (eip4361 payload, 65-byte eip191 signature)
 * and, when given, that the bytes hash to `expectedCid`.
 *
 * It does not verify the wallet signature: the Node verifies it when it
 * imports the delegation and is the authority on it. This decoder exists so
 * a caller can check what was signed (scope, audience, lifetime) instead of
 * trusting the request it made.
 */
export function decodeOwnerRootCacao(bytes: Uint8Array, expectedCid?: string): DecodedOwnerRootCacao {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_CACAO_BYTES) throw new Error("CACAO size is invalid");
  const cid = CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString();
  if (expectedCid !== undefined && cid !== expectedCid) throw new Error("CACAO bytes do not match the delegation CID");
  const envelope = map(decodeDagCbor(bytes), "envelope", ["h", "p", "s"]);
  if (map(envelope.h, "header", ["t"]).t !== "eip4361") throw new Error("CACAO header must be eip4361");
  const signature = map(envelope.s, "signature", ["t", "s"]);
  if (signature.t !== "eip191" || !(signature.s instanceof Uint8Array) || signature.s.length !== 65) throw new Error("CACAO signature must be a 65-byte eip191 signature");
  const payload = map(envelope.p, "payload", ["domain", "iss", "aud", "version", "nonce", "iat"], ["exp", "nbf", "statement", "requestId", "resources"]);
  if (payload.version !== 1) throw new Error("CACAO SIWE version must be 1");
  const optional = (key: string): string | undefined => payload[key] === undefined ? undefined : text(payload[key], key);
  let resources: string[] = [];
  if (payload.resources !== undefined) {
    if (!Array.isArray(payload.resources)) throw new Error("CACAO resources must be an array");
    resources = payload.resources.map((resource, index) => text(resource, `resources[${index}]`));
  }
  const last = resources.at(-1);
  const decodedReCap = last?.startsWith(RECAP_PREFIX) ? reCap(last) : { attenuation: Object.create(null) as DecodedOwnerRootCacao["attenuation"], proofs: [] };
  const expiresAt = optional("exp");
  const notBefore = optional("nbf");
  return {
    cid,
    issuer: text(payload.iss, "iss"),
    audience: text(payload.aud, "aud"),
    issuedAt: text(payload.iat, "iat"),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(notBefore === undefined ? {} : { notBefore }),
    resources,
    attenuation: decodedReCap.attenuation,
    reCapProofs: decodedReCap.proofs,
  };
}
