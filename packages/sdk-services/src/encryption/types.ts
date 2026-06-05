/**
 * Type definitions for TinyCloud one-of-one encryption.
 *
 * Wire shapes mirror the protocol described in the encryption
 * architecture: inline envelopes carry the encrypted symmetric key
 * alongside the ciphertext; decrypt requests are short-lived UCAN
 * invocations against a target node plus networkId.
 */

import type { Json } from "./canonical";

/** Default ciphersuite identifier for v1 envelopes. */
export const DEFAULT_ENCRYPTION_ALG = "x25519-aes256gcm/v1" as const;

/** Inline-envelope schema version. */
export const ENVELOPE_VERSION = 1 as const;

/** Default key version on freshly-created networks. */
export const DEFAULT_KEY_VERSION = 1 as const;

/** Decrypt-invocation fact type. */
export const DECRYPT_FACT_TYPE = "tinycloud.encryption.decrypt/v1" as const;

/** Decrypt response type. */
export const DECRYPT_RESULT_TYPE =
  "tinycloud.encryption.decrypt-result/v1" as const;

/** Encryption service identifier (manifest long form). */
export const ENCRYPTION_SERVICE = "tinycloud.encryption" as const;

/** Short form used in recap/abilities maps. */
export const ENCRYPTION_SERVICE_SHORT = "encryption" as const;

/** Decrypt ability URN. */
export const DECRYPT_ACTION = "tinycloud.encryption/decrypt" as const;

/**
 * Inline encrypted envelope persisted in KV/SQL records.
 *
 * - `encryptedSymmetricKey` is opaque to the SDK; only the network can
 *   unwrap it.
 * - `encryptedSymmetricKeyHash` is the canonical hash of the wrapped key
   *   bytes (hex-encoded sha-256 of the base64 string's canonical JSON
   *   form). The node recomputes this on every decrypt request.
 * - `ciphertext` and `aad` are payload bytes only; the node never sees
 *   them.
 */
export interface InlineEncryptedEnvelope {
  /** Schema version. */
  v: typeof ENVELOPE_VERSION;
  /** Network id URN. */
  networkId: string;
  /** Ciphersuite identifier. */
  alg: string;
  /** Network key version that was used to wrap the symmetric key. */
  keyVersion: number;
  /** Base64-encoded wrapped symmetric key / capsule. */
  encryptedSymmetricKey: string;
  /** Hex sha-256 of the canonical encryptedSymmetricKey string. */
  encryptedSymmetricKeyHash: string;
  /** Base64-encoded payload ciphertext. */
  ciphertext: string;
  /** Base64-encoded associated data, if any. */
  aad?: string;
  /** Caller-supplied metadata. Not authenticated against the node. */
  metadata?: Record<string, string>;
}

/**
 * Node-published network descriptor. The node DB is authoritative; a
 * cached copy may also live under
 * `.well-known/encryption/network/<name>` in the principal's account
 * space (a discovery record only).
 */
export interface NetworkDescriptor {
  networkId: string;
  principal: string;
  name: string;
  members: ReadonlyArray<{ nodeId: string; role: "primary" | "share" }>;
  threshold: { n: number; t: number };
  state: "pending" | "generating" | "active" | "rotating" | "revoked" | "failed";
  /** Base64-encoded network public key. */
  publicEncryptionKey: string;
  alg: string;
  keyVersion: number;
  keyBackend: "local-one-of-one" | "dstack" | "threshold";
  createdAt: string;
  updatedAt: string;
}

/**
 * Decrypt-request body sent over the wire. Hashed (canonically) and
 * bound to the UCAN invocation via `facts.bodyHash`.
 */
export interface DecryptRequestBody {
  type: typeof DECRYPT_FACT_TYPE;
  targetNode: string;
  networkId: string;
  alg: string;
  keyVersion: number;
  /** Base64-encoded wrapped symmetric key from the envelope. */
  encryptedSymmetricKey: string;
  /** Recomputed hash of the wrapped key. */
  encryptedSymmetricKeyHash: string;
  /** Base64-encoded per-request receiver public key. */
  receiverPublicKey: string;
  /** Hash of the receiver public key. */
  receiverPublicKeyHash: string;
}

/**
 * Decrypt-response body returned by the node. The SDK verifies the
 * signature, recomputes hashes, then unwraps `wrappedKey` with the
 * per-request receiver private key before decrypting the payload.
 */
export interface DecryptResponseBody {
  type: typeof DECRYPT_RESULT_TYPE;
  targetNode: string;
  networkId: string;
  invocationCid: string;
  encryptedSymmetricKeyHash: string;
  receiverPublicKeyHash: string;
  /** Base64-encoded symmetric key re-encrypted to receiverPublicKey. */
  wrappedKey: string;
  alg: string;
  keyVersion: number;
  requestHash: string;
  nodeId: string;
  /** Base64-encoded ed25519 signature over canonical(response - signature field). */
  nodeSignature: string;
}

/**
 * Decrypt-invocation facts attached to the UCAN. Verifiers recompute
 * `bodyHash`, `encryptedSymmetricKeyHash`, and `receiverPublicKeyHash`
 * from the request body and reject any mismatch.
 */
export interface DecryptInvocationFact {
  type: typeof DECRYPT_FACT_TYPE;
  targetNode: string;
  networkId: string;
  bodyHash: string;
  encryptedSymmetricKeyHash: string;
  receiverPublicKeyHash: string;
  alg: string;
  keyVersion: number;
}

/**
 * Per-request receiver key pair (x25519). The private key never
 * leaves the SDK; the public key is sent to the node so the node can
 * rewrap the symmetric key.
 */
export interface ReceiverKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Crypto primitives injected into the encryption module. The SDK
 * provides these via WASM bindings; tests provide simple in-memory
 * implementations.
 */
export interface EncryptionCrypto {
  /** SHA-256 → 32-byte digest. */
  sha256(data: Uint8Array): Uint8Array;
  /** Cryptographically secure random bytes. */
  randomBytes(length: number): Uint8Array;
  /** Derive an x25519 key pair from a 32-byte seed. */
  x25519FromSeed(seed: Uint8Array): ReceiverKeyPair;
  /** Compute the x25519 ECDH shared secret. */
  x25519Dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** Authenticated symmetric encryption (the node's symmetric scheme). */
  authEncrypt(
    key: Uint8Array,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array;
  /** Authenticated symmetric decryption (matched to authEncrypt). */
  authDecrypt(
    key: Uint8Array,
    ciphertext: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array;
  /**
   * Wrap a symmetric key for the network's public encryption key using
   * a sealed-box / hpke / x25519+symmetric construction. Implementation
   * is opaque; only the node can unwrap.
   */
  sealToNetworkKey(
    networkPublicKey: Uint8Array,
    symmetricKey: Uint8Array,
  ): Uint8Array;
  /**
   * Open a wrapped symmetric key that was re-encrypted to the
   * per-request receiver public key. The matching private key must be
   * supplied here; the SDK never sends it to the node.
   */
  openWithReceiverKey(
    receiverPrivateKey: Uint8Array,
    wrappedKey: Uint8Array,
  ): Uint8Array;
  /**
   * Verify an ed25519 signature over `message` produced by the node
   * identified by `nodeId` (the public-key DID).
   */
  verifyNodeSignature(
    nodeId: string,
    message: Uint8Array,
    signature: Uint8Array,
  ): boolean;
}

/**
 * Signer interface used to derive a receiver key pair from a wallet or
 * session signer. The signature is HKDF-extracted into the receiver
 * seed so the public key is reproducible given the same context.
 */
export interface ReceiverKeySigner {
  signMessage(message: string): Promise<string>;
}

/** Capability proof material accompanying a decrypt invocation. */
export interface DecryptCapabilityProof {
  /** Delegation chain CIDs rooted at the network principal. */
  proofs: ReadonlyArray<string>;
  /** Optional Authorization header value to use instead of building one. */
  authorization?: string;
}

/**
 * Inputs to the decrypt invocation builder.
 */
export interface BuildDecryptInvocationInput {
  /** Target node DID — also the UCAN audience. */
  targetNode: string;
  /** Network id URN — also the recap resource. */
  networkId: string;
  /** Canonical body that will be POSTed. */
  body: DecryptRequestBody;
  /** Facts include hashes bound to the canonical body. */
  facts: DecryptInvocationFact;
  /** Capability proof chain. */
  proof: DecryptCapabilityProof;
  /** Optional `nbf` UCAN field as an ISO date string. */
  notBefore?: string;
  /** Optional `exp` UCAN field as an ISO date string. */
  expiration?: string;
}

/**
 * The output of {@link buildDecryptInvocation}.
 */
export interface BuiltDecryptInvocation {
  /** HTTP `Authorization` header value. */
  authorization: string;
  /** CID of the invocation (used by the node response binding). */
  invocationCid: string;
  /** Canonical body string the node will hash. */
  canonicalBody: string;
}

/**
 * Signer interface for producing the decrypt invocation. WASM bindings
 * implement this with the same session signer used for KV/SQL
 * invocations; tests can stub it.
 */
export interface DecryptInvocationSigner {
  signDecryptInvocation(input: BuildDecryptInvocationInput): Promise<BuiltDecryptInvocation>;
}

/**
 * Errors thrown / returned from the encryption module.
 */
export type EncryptionErrorInput =
  | { code: "NETWORK_NOT_FOUND"; networkId?: string; name?: string; message?: string }
  | { code: "NETWORK_NOT_ACTIVE"; state: string; message?: string }
  | { code: "INVALID_NETWORK_ID"; message: string }
  | { code: "INVALID_ENVELOPE"; message: string }
  | { code: "DECRYPT_DENIED"; message: string }
  | { code: "INVALID_RESPONSE"; message: string }
  | { code: "RESPONSE_SIGNATURE_INVALID"; message?: string }
  | { code: "RESPONSE_BINDING_MISMATCH"; field: string; message?: string }
  | { code: "TRANSPORT_ERROR"; cause: Error; message?: string }
  | { code: "INVALID_INPUT"; message: string };

export type EncryptionError = EncryptionErrorInput & {
  service: "encryption";
  message: string;
};

function defaultEncryptionMessage(input: EncryptionErrorInput): string {
  switch (input.code) {
    case "NETWORK_NOT_FOUND":
      return (
        input.message ??
        `Network not found: ${input.networkId ?? input.name ?? "<unknown>"}`
      );
    case "NETWORK_NOT_ACTIVE":
      return input.message ?? `Network not active (state=${input.state})`;
    case "INVALID_NETWORK_ID":
      return input.message;
    case "INVALID_ENVELOPE":
      return input.message;
    case "DECRYPT_DENIED":
      return input.message;
    case "INVALID_RESPONSE":
      return input.message;
    case "RESPONSE_SIGNATURE_INVALID":
      return input.message ?? "Node response signature failed to verify";
    case "RESPONSE_BINDING_MISMATCH":
      return (
        input.message ??
        `Node response binding mismatch on field ${JSON.stringify(input.field)}`
      );
    case "TRANSPORT_ERROR":
      return input.message ?? input.cause.message;
    case "INVALID_INPUT":
      return input.message;
  }
}

export function encryptionError(input: EncryptionErrorInput): EncryptionError {
  return {
    ...input,
    service: "encryption",
    message: defaultEncryptionMessage(input),
  };
}

/** Helper for the test/runtime layers to coerce arbitrary throwables. */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    return new Error(JSON.stringify(error));
  }
  return new Error(String(error));
}

/** Re-export for ergonomic typing of canonical payloads. */
export type CanonicalJson = Json;
