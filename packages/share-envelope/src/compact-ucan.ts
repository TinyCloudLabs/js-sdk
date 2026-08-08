import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { fromBase64Url, toBase64Url } from "./bytes.js";
import { canonicalize } from "./jcs.js";
import { ed25519PublicKeyFromDidKey } from "./didkey.js";

export interface CompactUcanAuthorization {
  readonly authorization: string;
  readonly cid: string;
  readonly header: Readonly<Record<string, unknown>>;
  readonly payload: {
    readonly att: Readonly<Record<string, unknown>>;
    readonly aud: string;
    readonly exp: number;
    readonly fct: readonly [Readonly<Record<string, unknown>>];
    readonly iss: string;
    readonly nbf: number;
    readonly nnc: string;
    readonly prf: readonly string[];
  };
}

export interface SignCompactUcanInput {
  readonly issuerDid: string;
  readonly audienceDid: string;
  readonly attenuation: Readonly<Record<string, unknown>>;
  readonly facts: readonly [Readonly<Record<string, unknown>>];
  readonly proofs: readonly string[];
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/** Produce the exact JCS compact-UCAN representation accepted by the Node. */
export async function signCompactUcanAuthorization(
  input: SignCompactUcanInput,
): Promise<CompactUcanAuthorization> {
  if (input.notBefore >= input.expiresAt || input.expiresAt - input.notBefore > 60) {
    throw new TypeError("compact invocation lifetime must be between one and 60 seconds");
  }
  const principal = input.issuerDid.split("#", 1)[0]!;
  const publicKey = ed25519PublicKeyFromDidKey(principal);
  const header = {
    alg: "EdDSA",
    jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: toBase64Url(publicKey) },
    typ: "JWT",
    ucv: "0.10.0",
  };
  const payload = {
    att: input.attenuation,
    aud: input.audienceDid,
    exp: input.expiresAt,
    fct: input.facts,
    iss: input.issuerDid.includes("#")
      ? input.issuerDid
      : `${principal}#${principal.slice("did:key:".length)}`,
    nbf: input.notBefore,
    nnc: input.nonce,
    prf: input.proofs,
  };
  const protectedSegment = toBase64Url(new TextEncoder().encode(canonicalize(header)));
  const payloadSegment = toBase64Url(new TextEncoder().encode(canonicalize(payload)));
  const signingInput = new TextEncoder().encode(`${protectedSegment}.${payloadSegment}`);
  const signature = await input.sign(signingInput);
  if (signature.length !== 64) throw new TypeError("compact Authorization signature must be Ed25519");
  return verifyCompactUcanAuthorization(
    `${protectedSegment}.${payloadSegment}.${toBase64Url(signature)}`,
  );
}

export function verifyCompactUcanAuthorization(
  authorization: string,
  expectedCid?: string,
): CompactUcanAuthorization {
  if (/\s/.test(authorization)) throw new TypeError("compact Authorization contains whitespace");
  const segments = authorization.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) throw new TypeError("compact Authorization must contain three segments");
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const headerBytes = fromBase64Url(headerSegment);
  const payloadBytes = fromBase64Url(payloadSegment);
  const signature = fromBase64Url(signatureSegment);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const header = JSON.parse(decoder.decode(headerBytes)) as Record<string, unknown>;
  const payload = JSON.parse(decoder.decode(payloadBytes)) as Record<string, unknown>;
  if (canonicalize(header) !== decoder.decode(headerBytes) || canonicalize(payload) !== decoder.decode(payloadBytes)) throw new TypeError("compact Authorization JSON is not canonical");
  assertExactKeys(header, ["alg", "jwk", "typ", "ucv"], "protected header");
  const jwk = object(header.jwk, "protected JWK");
  assertExactKeys(jwk, ["alg", "crv", "kty", "x"], "protected JWK");
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || header.ucv !== "0.10.0" || jwk.alg !== "EdDSA" || jwk.crv !== "Ed25519" || jwk.kty !== "OKP" || typeof jwk.x !== "string") throw new TypeError("compact Authorization header is invalid");
  assertExactKeys(payload, ["att", "aud", "exp", "fct", "iss", "nbf", "nnc", "prf"], "UCAN payload");
  if (typeof payload.iss !== "string" || typeof payload.aud !== "string" || typeof payload.nnc !== "string" || !Number.isInteger(payload.nbf) || !Number.isInteger(payload.exp) || (payload.nbf as number) >= (payload.exp as number) || !Array.isArray(payload.prf) || payload.prf.some((proof) => typeof proof !== "string") || !Array.isArray(payload.fct) || payload.fct.length !== 1) throw new TypeError("compact Authorization payload is invalid");
  const principal = payload.iss.split("#", 1)[0]!;
  const publicKey = ed25519PublicKeyFromDidKey(principal);
  if (!equal(publicKey, fromBase64Url(jwk.x))) throw new TypeError("compact Authorization JWK does not bind issuer");
  if (!ed25519.verify(signature, new TextEncoder().encode(`${headerSegment}.${payloadSegment}`), publicKey, { zip215: false })) throw new TypeError("compact Authorization signature is invalid");
  const cid = CID.createV1(0x55, createDigest(0x1e, blake3(new TextEncoder().encode(authorization)))).toString();
  if (expectedCid !== undefined && cid !== expectedCid) throw new TypeError("compact Authorization CID mismatch");
  return { authorization, cid, header, payload: payload as CompactUcanAuthorization["payload"] };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError(`${label} has unknown or missing fields`);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
