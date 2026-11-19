import { fromBase64Url } from "@tinycloud/share-envelope";

/**
 * The signed `Issued At` and `Not Before` of a SIWE CACAO, read from its
 * DAG-CBOR bytes. Security-sensitive, but narrow: call it only on bytes the
 * injected parser (sdk-core `parseSignedSiweCacao`) has already verified
 * (canonical encoding, exact-bytes CID, EIP-191 signature), which reports the
 * expiry but not these two times. Reading them here keeps sdk-core, and the
 * bundles built on it, unchanged.
 *
 * Supports the DAG-CBOR subset a CACAO uses: unsigned/negative integers, byte
 * and text strings, arrays, text-keyed maps, false/true/null; definite
 * lengths only, bounded depth. Anything else throws.
 */
export interface CacaoTimes {
  readonly issuedAt?: string;
  readonly notBefore?: string;
}

const MAX_DEPTH = 32;

function decode(bytes: Uint8Array): unknown {
  let offset = 0;
  const take = (length: number): Uint8Array => {
    if (length > bytes.length - offset) throw new Error("CACAO ended early");
    const out = bytes.subarray(offset, offset + length);
    offset += length;
    return out;
  };
  const read = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new Error("CACAO nesting is too deep");
    const initial = take(1)[0]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("unsupported CBOR simple value");
    }
    let argument: number;
    if (info < 24) argument = info;
    else if (info === 24) argument = take(1)[0]!;
    else if (info === 25) { const b = take(2); argument = (b[0]! << 8) | b[1]!; }
    else if (info === 26) { const b = take(4); argument = ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!; }
    else throw new Error("unsupported CBOR length");
    switch (major) {
      case 0: return argument;
      case 1: return -1 - argument;
      case 2: return take(argument);
      case 3: return new TextDecoder("utf-8", { fatal: true }).decode(take(argument));
      case 4: return Array.from({ length: argument }, () => read(depth + 1));
      case 5: {
        const map = new Map<string, unknown>();
        for (let index = 0; index < argument; index++) {
          const key = read(depth + 1);
          if (typeof key !== "string" || map.has(key)) throw new Error("CBOR map key is invalid");
          map.set(key, read(depth + 1));
        }
        return map;
      }
      default: throw new Error("unsupported CBOR type");
    }
  };
  const value = read(0);
  if (offset !== bytes.length) throw new Error("CACAO has trailing bytes");
  return value;
}

export function cacaoTimes(authorization: string): CacaoTimes {
  const root = decode(fromBase64Url(authorization.replace(/=+$/, "")));
  const payload = root instanceof Map ? root.get("p") : undefined;
  if (!(payload instanceof Map)) throw new Error("CACAO payload is missing");
  const text = (key: string): string | undefined => {
    const value = payload.get(key);
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`CACAO ${key} is not text`);
    return value;
  };
  const issuedAt = text("iat");
  const notBefore = text("nbf");
  return { ...(issuedAt === undefined ? {} : { issuedAt }), ...(notBefore === undefined ? {} : { notBefore }) };
}
