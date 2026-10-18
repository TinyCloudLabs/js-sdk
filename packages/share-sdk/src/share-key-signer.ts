import { ed25519 } from "@noble/curves/ed25519";
import {
  canonicalize,
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyFromDidKey,
  toBase64Url,
  verifyCompactUcanAuthorization,
  type CompactUcanAuthorization,
} from "@tinycloud/share-envelope";
import type { DelegatedShareKey } from "./owner-policy.js";

/**
 * Link signing outside WASM. The SDK's WASM delegation builder signs with a
 * raw session JWK; a share key must never exist as raw bytes in a browser.
 * These helpers build the same compact UCAN the Node accepts and hand only
 * the exact signing input to the key's `sign`, so the key can be a
 * non-extractable WebCrypto Ed25519 handle (browser: kept in IndexedDB;
 * Node/CLI: imported non-extractable from its own 0600 key file).
 */
export type ShareKeySigner = Pick<DelegatedShareKey, "did" | "sign">;

/**
 * Throw unless `key` is a non-extractable Ed25519 WebCrypto private key whose
 * public half is `key.did`. The binding is checked by signing a fixed probe
 * and verifying it against the DID, so a root is never requested for a key
 * this process cannot actually use.
 */
export async function assertNonExtractableShareKey(key: DelegatedShareKey): Promise<void> {
  const handle: CryptoKey | undefined = key.cryptoKey;
  if (
    key.extractable !== false
    || handle === undefined
    || handle.extractable !== false
    || handle.type !== "private"
    || handle.algorithm?.name !== "Ed25519"
    || !handle.usages.includes("sign")
  ) throw new TypeError("share key must be a non-extractable Ed25519 WebCrypto private key");
  if (key.did !== didKeyFromEd25519PublicKey(key.publicKey)) throw new TypeError("share key DID does not match its public key");
  const probe = new TextEncoder().encode("xyz.tinycloud.share/share-key-binding/v1");
  if (!ed25519.verify(await key.sign(probe), probe, key.publicKey, { zip215: false })) throw new TypeError("share key does not sign for its DID");
}

export interface ShareKeyDelegationInput {
  readonly key: ShareKeySigner;
  readonly audienceDid: string;
  /** Resource -> ability -> caveats; the caller bounds it (see `ShareRoot.signBearerLink`). */
  readonly attenuation: Readonly<Record<string, Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>>>;
  readonly proofs: readonly string[];
  /** Unix seconds. */
  readonly notBefore: number;
  /** Unix seconds. */
  readonly expiresAt: number;
  readonly nonce?: string;
}

/**
 * Sign a compact UCAN delegation (JCS header and payload, EdDSA) with a share
 * key. Unlike share-envelope's invocation signer it is not limited to 60 s:
 * lifetime limits belong to the caller. The result is re-verified (signature,
 * issuer binding, canonical JSON) before it is returned.
 */
export async function signShareKeyDelegation(input: ShareKeyDelegationInput): Promise<CompactUcanAuthorization> {
  if (!Number.isSafeInteger(input.notBefore) || !Number.isSafeInteger(input.expiresAt) || input.notBefore >= input.expiresAt) {
    throw new TypeError("share key delegation lifetime is invalid");
  }
  const principal = input.key.did.split("#", 1)[0]!;
  const publicKey = ed25519PublicKeyFromDidKey(principal);
  ed25519PublicKeyFromDidKey(input.audienceDid.split("#", 1)[0]!);
  const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: toBase64Url(publicKey) }, typ: "JWT", ucv: "0.10.0" };
  const payload = {
    att: input.attenuation,
    aud: input.audienceDid,
    exp: input.expiresAt,
    fct: [{}],
    iss: `${principal}#${principal.slice("did:key:".length)}`,
    nbf: input.notBefore,
    nnc: input.nonce ?? `urn:uuid:${crypto.randomUUID()}`,
    prf: input.proofs,
  };
  const signingInput = `${toBase64Url(new TextEncoder().encode(canonicalize(header)))}.${toBase64Url(new TextEncoder().encode(canonicalize(payload)))}`;
  const signature = await input.key.sign(new TextEncoder().encode(signingInput));
  if (signature.length !== 64) throw new TypeError("share key signature must be Ed25519");
  return verifyCompactUcanAuthorization(`${signingInput}.${toBase64Url(signature)}`);
}
