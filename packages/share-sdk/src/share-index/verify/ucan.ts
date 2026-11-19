import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { ed25519PublicKeyFromDidKey, fromBase64Url } from "@tinycloud/share-envelope";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";

/**
 * Signed UCAN verifier for issued delegations (native bearer link
 * delegations and Policy/v3 owner roots). Security-sensitive.
 *
 * Same acceptance as sdk-core `parseSignedCompactUcanAttenuation`
 * (`unified.ts:1281-1314`): EdDSA/JWT/ucv 0.10.0 header whose JWK binds the
 * did:key issuer, strict Ed25519 signature, CID = CIDv1(raw, blake3) of the
 * exact Authorization bytes. It additionally returns the verified `prf`,
 * `nbf` and `exp` (design C4), and requires `exp`: an expiry-less delegation
 * is refused. Payload JSON need not be JCS: WASM-issued link delegations are
 * not.
 */
export interface SignedUcanDelegation {
  readonly cid: string;
  /** Issuer principal without any `#fragment`. */
  readonly issuer: string;
  /** Audience principal without any `#fragment`. */
  readonly audience: string;
  readonly attenuation: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;
  readonly proofs: readonly string[];
  readonly notBefore?: number;
  readonly expiresAt: number;
  readonly facts?: readonly unknown[];
}

const MAX_UCAN_LENGTH = 32 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `did:key:z…#z…` and `did:key:z…` name the same principal. */
export function principalOf(did: string): string {
  return did.split("#", 1)[0]!;
}

export function ucanCid(authorization: string): string {
  return CID.createV1(0x55, createDigest(0x1e, blake3(new TextEncoder().encode(authorization)))).toString();
}

export function parseSignedUcan(authorization: string, expectedCid?: string): SignedUcanDelegation {
  if (typeof authorization !== "string" || authorization.length > MAX_UCAN_LENGTH || /\s/.test(authorization)) throw new Error("UCAN must be compact bytes");
  const segments = authorization.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) throw new Error("UCAN must have three segments");
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(decoder.decode(fromBase64Url(headerSegment)));
    payload = JSON.parse(decoder.decode(fromBase64Url(payloadSegment)));
  } catch {
    throw new Error("UCAN segments are not JSON");
  }
  if (!record(header) || !record(header.jwk) || header.alg !== "EdDSA" || header.typ !== "JWT" || header.ucv !== "0.10.0" || header.jwk.kty !== "OKP" || header.jwk.crv !== "Ed25519" || typeof header.jwk.x !== "string") throw new Error("UCAN header is invalid");
  if (!record(payload) || typeof payload.iss !== "string" || typeof payload.aud !== "string" || payload.aud.length === 0) throw new Error("UCAN issuer or audience is invalid");
  const issuer = principalOf(payload.iss);
  const publicKey = ed25519PublicKeyFromDidKey(issuer);
  const jwkKey = fromBase64Url(header.jwk.x);
  if (jwkKey.length !== publicKey.length || jwkKey.some((byte, index) => byte !== publicKey[index])) throw new Error("UCAN JWK does not bind the issuer");
  const signature = fromBase64Url(signatureSegment);
  if (signature.length !== 64 || !ed25519.verify(signature, new TextEncoder().encode(`${headerSegment}.${payloadSegment}`), publicKey, { zip215: false })) throw new Error("UCAN signature is invalid");
  const cid = ucanCid(authorization);
  if (expectedCid !== undefined && cid !== expectedCid) throw new Error("UCAN CID does not match its exact bytes");
  const att = payload.att;
  if (!record(att) || Object.keys(att).length === 0 || !Object.values(att).every((abilities) => record(abilities) && Object.keys(abilities).length > 0 && Object.values(abilities).every((caveats) => Array.isArray(caveats) && caveats.length > 0))) throw new Error("UCAN attenuation is invalid");
  const prf = payload.prf ?? [];
  if (!Array.isArray(prf) || !prf.every((item) => typeof item === "string")) throw new Error("UCAN proofs are invalid");
  if (!Number.isSafeInteger(payload.exp) || (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || (payload.nbf as number) >= (payload.exp as number)))) throw new Error("UCAN validity window is invalid");
  if (payload.fct !== undefined && !Array.isArray(payload.fct)) throw new Error("UCAN facts are invalid");
  return {
    cid,
    issuer,
    audience: principalOf(payload.aud),
    attenuation: att as SignedUcanDelegation["attenuation"],
    proofs: prf as string[],
    ...(payload.nbf === undefined ? {} : { notBefore: payload.nbf as number }),
    expiresAt: payload.exp as number,
    ...(payload.fct === undefined ? {} : { facts: payload.fct as unknown[] }),
  };
}
