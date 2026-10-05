import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";

import { ReplicaError, ReplicaErrorCode } from "./errors.js";
import { kvPrefixCovers } from "./scope.js";
import type { GrantRecord } from "./types.js";

/** A compact UCAN grant whose Ed25519 signature checked out against its issuer. */
export type ParsedUcanGrant = GrantRecord & {
  /** The signed attenuation: resource → ability → caveats. */
  att: Record<string, Record<string, unknown>>;
  /** Signed proof CIDs. */
  prf: string[];
  /** The compact JWT, without any `Bearer ` prefix. */
  jwt: string;
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error("invalid base58");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

function base64UrlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = globalThis.atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * The canonical TinyCloud delegation CID of a compact UCAN: CIDv1, raw codec
 * (0x55), blake3-256 multihash over the JWT's UTF-8 bytes, base32 multibase.
 * Matches `computeCid(bytes, 0x55)` in the SDK's WASM bindings.
 */
export function ucanCid(jwt: string): string {
  const digest = blake3(new TextEncoder().encode(jwt));
  const bytes = new Uint8Array(4 + digest.length);
  bytes.set([0x01, 0x55, 0x1e, 0x20]);
  bytes.set(digest, 4);
  return `b${base32Encode(bytes)}`;
}

/** The raw Ed25519 public key of a `did:key:z6Mk…` DID (fragment ignored). */
function ed25519KeyOfDid(did: string): Uint8Array | undefined {
  const bare = did.split("#", 1)[0]!;
  if (!bare.startsWith("did:key:z")) return undefined;
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(bare.slice("did:key:z".length));
  } catch {
    return undefined;
  }
  // multicodec ed25519-pub = 0xed (varint 0xed 0x01)
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) return undefined;
  return decoded.subarray(2);
}

function invalid(message: string): ReplicaError {
  return new ReplicaError(ReplicaErrorCode.GRANT_INVALID, message);
}

/**
 * Parse and verify a compact UCAN grant. Worker-safe (no Node APIs).
 * Everything returned — audience, window, attenuation, proofs — comes from
 * the signed payload, never from wrapper fields around it. Verifying the
 * signature proves the issuer signed exactly these claims; whether the chain
 * holds is the node's call on every sync.
 */
export function parseUcanGrant(input: Uint8Array | string): ParsedUcanGrant {
  const raw = typeof input === "string" ? input : new TextDecoder().decode(input);
  const jwt = raw.trim().replace(/^Bearer\s+/i, "");
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new ReplicaError(
      ReplicaErrorCode.GRANT_FORMAT_UNSUPPORTED,
      "The grant is not a compact UCAN. SIWE/CACAO grants cannot back a replica; ask the owner for a device grant (tc auth grant).",
    );
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
    signature = base64UrlDecode(signaturePart);
  } catch {
    throw invalid("The grant is not well-formed base64url JSON.");
  }
  if (header?.alg !== "EdDSA") {
    throw new ReplicaError(
      ReplicaErrorCode.GRANT_FORMAT_UNSUPPORTED,
      `The grant is signed with ${String(header?.alg)}; a replica needs an Ed25519 (EdDSA) device grant.`,
    );
  }
  const issuer = payload?.iss;
  const audience = payload?.aud;
  if (typeof issuer !== "string" || typeof audience !== "string" || audience.length === 0) {
    throw invalid("The grant has no signed issuer or audience.");
  }
  const key = ed25519KeyOfDid(issuer);
  if (key === undefined) {
    throw new ReplicaError(
      ReplicaErrorCode.GRANT_FORMAT_UNSUPPORTED,
      `The grant issuer ${issuer} is not an Ed25519 did:key.`,
    );
  }
  let verified = false;
  try {
    verified = ed25519.verify(signature, new TextEncoder().encode(`${headerPart}.${payloadPart}`), key);
  } catch {
    verified = false;
  }
  if (!verified) throw invalid("The grant's signature does not verify against its issuer.");

  const att = payload.att;
  if (att === null || typeof att !== "object" || Array.isArray(att)) throw invalid("The grant has no signed attenuation.");
  for (const abilities of Object.values(att)) {
    if (abilities === null || typeof abilities !== "object" || Array.isArray(abilities)) {
      throw invalid("The grant has a malformed signed attenuation.");
    }
  }
  const prf = payload.prf ?? [];
  if (!Array.isArray(prf) || prf.some((proof) => typeof proof !== "string")) throw invalid("The grant has malformed signed proofs.");
  const window = (name: "nbf" | "exp"): number | null => {
    const value = payload[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`The grant's signed ${name} is not a number.`);
    return value;
  };

  return {
    cid: ucanCid(jwt),
    bytes: new TextEncoder().encode(jwt),
    jwt,
    issuer,
    audience,
    notBefore: window("nbf"),
    expiresAt: window("exp"),
    att: att as Record<string, Record<string, unknown>>,
    prf: prf as string[],
  };
}

/** The KV path a signed resource names in `space`, or undefined for any other resource. */
function kvPathIn(resource: string, space: string): string | undefined {
  for (const base of [`${space}/kv/`, `tinycloud://${space}/kv/`]) {
    if (resource.startsWith(base)) return resource.slice(base.length);
  }
  return undefined;
}

/** True when the signed attenuation grants `ability` on a KV path covering `prefix`. */
export function grantCovers(grant: Pick<ParsedUcanGrant, "att">, space: string, prefix: string, ability: string): boolean {
  for (const [resource, abilities] of Object.entries(grant.att)) {
    const path = kvPathIn(resource, space);
    if (path === undefined || !kvPrefixCovers(path, prefix)) continue;
    // `tinycloud.kv/sync` is never implied by a wildcard (TC-732).
    if (ability in abilities) return true;
    if (ability !== "tinycloud.kv/sync" && ability !== "tinycloud.kv/retain" && "tinycloud.kv/*" in abilities) return true;
  }
  return false;
}

/** The space ids (native form) for which the grant carries `tinycloud.kv/sync`. */
export function syncGrantSpaces(grant: Pick<ParsedUcanGrant, "att">): string[] {
  const spaces = new Set<string>();
  for (const [resource, abilities] of Object.entries(grant.att)) {
    if (!("tinycloud.kv/sync" in abilities)) continue;
    const match = /^(?:tinycloud:\/\/)?(tinycloud:[^/]+)\/kv\//.exec(resource);
    if (match) spaces.add(match[1]!);
  }
  return [...spaces];
}

/**
 * Install-time checks: the grant must name this device, cover both
 * `tinycloud.kv/sync` and `tinycloud.kv/get` on the prefix, and be inside its
 * own signed window. The node re-checks the whole chain on every sync.
 */
export function assertGrantInstallable(
  grant: ParsedUcanGrant,
  input: { deviceDid: string; space: string; prefix: string; now: number },
): void {
  if (grant.audience.split("#", 1)[0] !== input.deviceDid.split("#", 1)[0]) {
    throw new ReplicaError(
      ReplicaErrorCode.GRANT_AUDIENCE_MISMATCH,
      `The grant was issued to ${grant.audience}, not this device (${input.deviceDid}).`,
    );
  }
  for (const ability of ["tinycloud.kv/sync", "tinycloud.kv/get"]) {
    if (!grantCovers(grant, input.space, input.prefix, ability)) {
      throw new ReplicaError(
        ReplicaErrorCode.GRANT_NOT_COVERING,
        `The grant does not carry ${ability} on ${input.space}/kv/${input.prefix}.`,
        { ability },
      );
    }
  }
  const nowSeconds = input.now / 1000;
  if (grant.notBefore !== null && nowSeconds < grant.notBefore) {
    throw new ReplicaError(
      ReplicaErrorCode.GRANT_NOT_YET_VALID,
      `The grant is not valid before ${new Date(grant.notBefore * 1000).toISOString()}.`,
    );
  }
  if (grant.expiresAt !== null && nowSeconds >= grant.expiresAt) {
    throw new ReplicaError(
      ReplicaErrorCode.GRANT_EXPIRED,
      `The grant expired at ${new Date(grant.expiresAt * 1000).toISOString()}.`,
    );
  }
}
