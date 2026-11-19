import { ed25519 } from "@noble/curves/ed25519";

import { fromBase64Url } from "../bytes.js";
import { didKeyFromEd25519PublicKey } from "../didkey.js";
import { LinkError } from "./errors.js";

/**
 * The issuer of a link. The caller keeps the private key: the module only
 * asks for a signature.
 *
 * `sign` receives the 32-byte SHA-256 digest of the signed bytes and returns
 * the 64-byte Ed25519 signature of that digest (pure Ed25519 over the digest,
 * as the contract's scheme requires). `did` is the signer's Ed25519 `did:key`
 * and is the issuer written into every header and delete request.
 */
export interface LinkSigner {
  readonly did: string;
  sign(digest: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/** An Ed25519 private key as a JWK (RFC 8037). `x` is the public key and `d` the 32-byte seed, both unpadded base64url. */
export interface Ed25519PrivateJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly d: string;
}

/** A signer over a 32-byte Ed25519 seed. For tests and simple callers; production callers pass their own signer. */
export function signerFromSeed(seed: Uint8Array): LinkSigner {
  if (seed.length !== 32) throw new LinkError("invalid_argument", "an Ed25519 seed is 32 bytes");
  const copy = Uint8Array.from(seed);
  return {
    did: didKeyFromEd25519PublicKey(ed25519.getPublicKey(copy)),
    sign: (digest) => ed25519.sign(digest, copy),
  };
}

/** A signer over an Ed25519 JWK. `x` must be the public key of `d`. */
export function signerFromJwk(jwk: Ed25519PrivateJwk): LinkSigner {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") throw new LinkError("invalid_argument", "the JWK is not an Ed25519 key");
  let seed: Uint8Array;
  let publicKey: Uint8Array;
  try {
    seed = fromBase64Url(jwk.d);
    publicKey = fromBase64Url(jwk.x);
  } catch {
    throw new LinkError("invalid_argument", "the JWK is not canonical base64url");
  }
  const signer = signerFromSeed(seed);
  if (signer.did !== didKeyFromEd25519PublicKey(publicKey)) throw new LinkError("invalid_argument", "the JWK public key does not match its private key");
  return signer;
}
