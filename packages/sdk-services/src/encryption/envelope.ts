/**
 * Inline-envelope encrypt / decrypt helpers.
 *
 * Encryption is fully local: the SDK generates a per-record symmetric
 * key, encrypts the payload, then wraps the symmetric key against the
 * network's public encryption key. The wrapped key (and key hash)
 * travels alongside the ciphertext inside an
 * {@link InlineEncryptedEnvelope}.
 *
 * Decryption is split: the node unwraps the symmetric key to the
 * per-request receiver public key (see {@link buildDecryptInvocation}
 * and the decrypt route); this module is responsible for the local
 * payload decryption once the symmetric key is available.
 */

import {
  base64Decode,
  base64Encode,
  canonicalHashHex,
} from "./canonical";
import {
  DEFAULT_ENCRYPTION_ALG,
  DEFAULT_KEY_VERSION,
  ENVELOPE_VERSION,
  encryptionError,
  type EncryptionCrypto,
  type EncryptionError,
  type InlineEncryptedEnvelope,
} from "./types";
import { NetworkIdError, parseEncryptionResource } from "./networkId";
import { assertKeyWrapAlgorithm, assertKeyWrapContext, KEY_WRAP_V2_ALG, readKeyWrapV2, sealKeyV2 } from "./keyWrap";

export interface EncryptToNetworkInput {
  /** Target network id URN. */
  networkId: string;
  /** Exact named-key path; omitted for a network-root key. */
  keyPath?: string;
  /** Network public key bytes (already discovered). */
  networkPublicKey: Uint8Array;
  /** Payload bytes to encrypt. Callers serialize objects to bytes themselves. */
  plaintext: Uint8Array;
  /** Optional associated authenticated data. */
  aad?: Uint8Array;
  /** Ciphersuite identifier. Defaults to {@link DEFAULT_ENCRYPTION_ALG}. */
  alg?: string;
  /** Key version. Defaults to {@link DEFAULT_KEY_VERSION}. */
  keyVersion?: number;
  /** Caller-supplied envelope metadata. */
  metadata?: Record<string, string>;
  /** Write TCW2 key wraps. Disabled by default. */
  keyWrapV2?: boolean;
}

export interface EncryptToNetworkResult {
  envelope: InlineEncryptedEnvelope;
  /** Symmetric key returned for caller bookkeeping; do NOT persist. */
  symmetricKey: Uint8Array;
}

/**
 * Local-only encrypt: generates a symmetric key, encrypts the payload,
 * wraps the key against the network public key, and returns the
 * inline envelope.
 */
export function encryptToNetwork(
  crypto: EncryptionCrypto,
  input: EncryptToNetworkInput,
): EncryptToNetworkResult {
  const parsedResource = parseEncryptionResource(
    input.keyPath === undefined
      ? input.networkId
      : `${input.networkId}/${input.keyPath}`,
  );
  if (
    parsedResource.keyPath !== input.keyPath ||
    input.keyPath?.endsWith("/")
  ) {
    throw new NetworkIdError("keyPath must name an exact encryption key");
  }
  const alg = input.keyWrapV2 ? KEY_WRAP_V2_ALG : DEFAULT_ENCRYPTION_ALG;
  if (input.alg !== undefined && input.alg !== alg) {
    throw new Error("Algorithm does not match keyWrapV2");
  }
  const keyVersion = input.keyVersion ?? DEFAULT_KEY_VERSION;

  const symmetricKey = crypto.randomBytes(32);
  const ciphertext = crypto.authEncrypt(symmetricKey, input.plaintext, input.aad);
  const wrapped = input.keyWrapV2
    ? sealKeyV2(input.networkPublicKey, symmetricKey, {
      purpose: "network-key", networkId: input.networkId, keyPath: input.keyPath ?? "",
      keyVersion, metadata: input.metadata ?? {},
    })
    : crypto.sealToNetworkKey(input.networkPublicKey, symmetricKey);
  const encryptedSymmetricKey = base64Encode(wrapped);
  const encryptedSymmetricKeyHash = canonicalHashHex(
    crypto.sha256,
    encryptedSymmetricKey,
  );

  const envelope: InlineEncryptedEnvelope = {
    v: ENVELOPE_VERSION,
    networkId: input.networkId,
    ...(input.keyPath !== undefined ? { keyPath: input.keyPath } : {}),
    alg,
    keyVersion,
    encryptedSymmetricKey,
    encryptedSymmetricKeyHash,
    ciphertext: base64Encode(ciphertext),
    ...(input.aad !== undefined ? { aad: base64Encode(input.aad) } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };

  return { envelope, symmetricKey };
}

/**
 * Validate an inline envelope shape. Returns an error if the envelope
 * is missing required fields or fails internal hash recomputation.
 */
export function validateEnvelope(
  crypto: EncryptionCrypto,
  envelope: unknown,
  requireKeyWrapV2 = false,
): { ok: true; data: InlineEncryptedEnvelope } | { ok: false; error: EncryptionError } {
  if (envelope === null || typeof envelope !== "object") {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message: "envelope must be an object",
      }),
    };
  }
  const e = envelope as InlineEncryptedEnvelope;
  if (e.v !== ENVELOPE_VERSION) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message: `envelope.v must be ${ENVELOPE_VERSION} (got ${e.v as unknown as string})`,
      }),
    };
  }
  try {
    if (parseEncryptionResource(e.networkId).keyPath !== undefined) {
      throw new Error("networkId must identify the network root");
    }
    if (e.keyPath !== undefined) {
      if (typeof e.keyPath !== "string") {
        throw new Error("keyPath must be a string");
      }
      const parsed = parseEncryptionResource(`${e.networkId}/${e.keyPath}`);
      if (parsed.keyPath !== e.keyPath || e.keyPath.endsWith("/")) {
        throw new Error("keyPath must name an exact encryption key");
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message: `envelope encryption resource is malformed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
    };
  }
  for (const field of [
    "alg",
    "encryptedSymmetricKey",
    "encryptedSymmetricKeyHash",
    "ciphertext",
  ] as const) {
    if (typeof e[field] !== "string" || (e[field] as string).length === 0) {
      return {
        ok: false,
        error: encryptionError({
          code: "INVALID_ENVELOPE",
          message: `envelope.${field} must be a non-empty string`,
        }),
      };
    }
  }
  if (typeof e.keyVersion !== "number" || !Number.isInteger(e.keyVersion)) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message: "envelope.keyVersion must be an integer",
      }),
    };
  }
  const expectedHash = canonicalHashHex(crypto.sha256, e.encryptedSymmetricKey);
  if (expectedHash !== e.encryptedSymmetricKeyHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message:
          "envelope.encryptedSymmetricKeyHash does not match canonical hash of encryptedSymmetricKey",
      }),
    };
  }
  try {
    validateEnvelopeKeyWrap(e, requireKeyWrapV2);
  } catch {
    return { ok: false, error: encryptionError({ code: "INVALID_ENVELOPE", message: "Envelope key wrap context is invalid" }) };
  }
  return { ok: true, data: e };
}

/** The node authenticates this header; its signed response binds the exact capsule hash. */
export function validateEnvelopeKeyWrap(envelope: Pick<InlineEncryptedEnvelope, "alg" | "encryptedSymmetricKey" | "networkId" | "keyPath" | "keyVersion" | "metadata">, requireKeyWrapV2 = false): void {
  const wrapped = base64Decode(envelope.encryptedSymmetricKey);
  assertKeyWrapAlgorithm(wrapped, envelope.alg, requireKeyWrapV2);
  if (envelope.alg === KEY_WRAP_V2_ALG) {
    assertKeyWrapContext(readKeyWrapV2(wrapped).header, {
      purpose: "network-key", networkId: envelope.networkId, keyPath: envelope.keyPath ?? "",
      keyVersion: envelope.keyVersion, metadata: envelope.metadata ?? {},
    });
  }
}

/**
 * Decrypt an inline envelope given the unwrapped symmetric key.
 *
 * Callers typically obtain the symmetric key via the node decrypt
 * endpoint plus the per-request receiver key pair (see
 * `EncryptionService.decryptEnvelope`).
 */
export function decryptEnvelopeWithKey(
  crypto: EncryptionCrypto,
  envelope: InlineEncryptedEnvelope,
  symmetricKey: Uint8Array,
): Uint8Array {
  validateEnvelopeKeyWrap(envelope);
  const ciphertext = base64Decode(envelope.ciphertext);
  const aad = envelope.aad !== undefined ? base64Decode(envelope.aad) : undefined;
  return crypto.authDecrypt(symmetricKey, ciphertext, aad);
}
