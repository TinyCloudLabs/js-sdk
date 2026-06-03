/**
 * TinyCloud encryption decrypt-invocation builder.
 *
 * The decrypt invocation is a UCAN-style TinyCloud invocation against
 * a node plus a network id. It is structurally distinct from the
 * existing space-shaped invocations:
 *
 * - `aud` (audience) is the **target node DID** (not a space owner).
 * - `att` (attenuation) uses the **networkId URN** as the resource
 *   key (not a `tinycloud:pkh:...:<space>` URI).
 * - `fct` (facts) binds `bodyHash`, `encryptedSymmetricKeyHash`, and
 *   `receiverPublicKeyHash` so the node can recompute them from the
 *   POST body.
 *
 * Production callers inject a `DecryptInvocationSigner` backed by the
 * WASM UCAN/session signer. Tests pass a deterministic stub.
 */

import { canonicalize, canonicalHashHex, hexEncode, utf8Encode } from "./canonical";
import { parseNetworkId } from "./networkId";
import {
  DECRYPT_ACTION,
  DECRYPT_FACT_TYPE,
  ENCRYPTION_SERVICE,
  encryptionError,
  type BuildDecryptInvocationInput,
  type BuiltDecryptInvocation,
  type CanonicalJson,
  type DecryptCapabilityProof,
  type DecryptInvocationFact,
  type DecryptInvocationSigner,
  type DecryptRequestBody,
  type EncryptionCrypto,
  type EncryptionError,
} from "./types";

export interface CanonicalDecryptRequest {
  /** The canonical body that the node will hash. */
  canonicalBody: string;
  /** Hex sha-256 of the canonical body bytes. */
  bodyHash: string;
  /** Hex sha-256 of the receiver public key bytes. */
  receiverPublicKeyHash: string;
}

export interface BuildCanonicalDecryptRequestInput {
  crypto: EncryptionCrypto;
  body: DecryptRequestBody;
  receiverPublicKey: Uint8Array;
}

/**
 * Build the canonical body string and its bound hashes for a decrypt
 * request. The output is what gets POSTed to the node, and what the
 * node will hash to verify `facts.bodyHash`.
 */
export function buildCanonicalDecryptRequest(
  input: BuildCanonicalDecryptRequestInput,
): CanonicalDecryptRequest {
  const canonicalBody = canonicalize(input.body as unknown as CanonicalJson);
  const bodyHash = canonicalHashHex(
    input.crypto.sha256,
    input.body as unknown as CanonicalJson,
  );
  const receiverPublicKeyHash = canonicalHashHex(
    input.crypto.sha256,
    input.body.receiverPublicKey,
  );
  return { canonicalBody, bodyHash, receiverPublicKeyHash };
}

export interface BuildDecryptFactsInput {
  crypto: EncryptionCrypto;
  body: DecryptRequestBody;
  /** Encrypted symmetric key hash from the envelope (already canonical). */
  encryptedSymmetricKeyHash: string;
  /** Receiver public key bytes. */
  receiverPublicKey: Uint8Array;
  /** Canonical body string used to derive bodyHash. */
  canonicalBody?: string;
}

/**
 * Build the {@link DecryptInvocationFact} that will be embedded in the
 * UCAN `fct` field. Hashes are recomputed here so callers cannot drift
 * from the canonical body without the node noticing.
 */
export function buildDecryptFacts(
  input: BuildDecryptFactsInput,
): DecryptInvocationFact {
  // When a precomputed canonicalBody string is supplied, hash its bytes
  // directly. Don't route it through canonicalHashHex, which would
  // re-canonicalize the string itself (escaping it as a JSON value).
  const bodyHash =
    input.canonicalBody !== undefined
      ? hexEncode(input.crypto.sha256(utf8Encode(input.canonicalBody)))
      : canonicalHashHex(
          input.crypto.sha256,
          input.body as unknown as CanonicalJson,
        );
  const receiverPublicKeyHash = canonicalHashHex(
    input.crypto.sha256,
    input.body.receiverPublicKey,
  );
  return {
    type: DECRYPT_FACT_TYPE,
    targetNode: input.body.targetNode,
    networkId: input.body.networkId,
    bodyHash,
    encryptedSymmetricKeyHash: input.encryptedSymmetricKeyHash,
    receiverPublicKeyHash,
    alg: input.body.alg,
    keyVersion: input.body.keyVersion,
  };
}

/**
 * Recap-shaped attenuation for the decrypt invocation. The resource
 * key is the networkId URN; the ability is the long-form
 * `tinycloud.encryption/decrypt`. This is intentionally distinct from
 * the existing space-shaped invocation map so callers cannot
 * accidentally fake a space prefix.
 */
export function buildDecryptAttenuation(
  networkId: string,
): Record<string, Record<string, Record<string, never>>> {
  parseNetworkId(networkId);
  return {
    [networkId]: {
      [DECRYPT_ACTION]: {},
    },
  };
}

/**
 * Validate a {@link BuildDecryptInvocationInput} payload — the body
 * shape, the facts bindings, and the audience contract — without
 * actually signing. Returns either the input (typed) or a structured
 * error so callers can short-circuit before calling into WASM.
 */
export function checkDecryptInvocationInput(
  crypto: EncryptionCrypto,
  input: BuildDecryptInvocationInput,
):
  | { ok: true; data: BuildDecryptInvocationInput; canonicalBody: string }
  | { ok: false; error: EncryptionError } {
  if (input.body.type !== DECRYPT_FACT_TYPE) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: `body.type must be ${DECRYPT_FACT_TYPE}`,
      }),
    };
  }
  if (input.facts.type !== DECRYPT_FACT_TYPE) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: `facts.type must be ${DECRYPT_FACT_TYPE}`,
      }),
    };
  }
  if (input.facts.targetNode !== input.targetNode) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message:
          "facts.targetNode must equal targetNode — the UCAN audience binds the request to a single node",
      }),
    };
  }
  if (input.body.targetNode !== input.targetNode) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "body.targetNode must equal targetNode",
      }),
    };
  }
  if (input.facts.networkId !== input.networkId) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.networkId must equal networkId",
      }),
    };
  }
  if (input.body.networkId !== input.networkId) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "body.networkId must equal networkId",
      }),
    };
  }
  if (input.facts.alg !== input.body.alg) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.alg must equal body.alg",
      }),
    };
  }
  if (input.facts.keyVersion !== input.body.keyVersion) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.keyVersion must equal body.keyVersion",
      }),
    };
  }
  if (
    input.facts.encryptedSymmetricKeyHash !==
    input.body.encryptedSymmetricKeyHash
  ) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message:
          "facts.encryptedSymmetricKeyHash must equal body.encryptedSymmetricKeyHash",
      }),
    };
  }
  if (
    input.facts.receiverPublicKeyHash !== input.body.receiverPublicKeyHash
  ) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message:
          "facts.receiverPublicKeyHash must equal body.receiverPublicKeyHash",
      }),
    };
  }
  try {
    parseNetworkId(input.networkId);
  } catch (err) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
  const canonicalBody = canonicalize(
    input.body as unknown as CanonicalJson,
  );
  const expectedBodyHash = canonicalHashHex(crypto.sha256, input.body as unknown as CanonicalJson);
  if (expectedBodyHash !== input.facts.bodyHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.bodyHash does not match the canonical body hash",
      }),
    };
  }
  return { ok: true, data: input, canonicalBody };
}

/**
 * Compose the high-level decrypt invocation and hand it to the signer
 * for UCAN minting. The signer returns the Authorization header value
 * plus the invocation CID; this function only validates and
 * orchestrates — it does not perform crypto signing itself.
 */
export async function buildDecryptInvocation(
  crypto: EncryptionCrypto,
  signer: DecryptInvocationSigner,
  input: BuildDecryptInvocationInput,
): Promise<{ ok: true; data: BuiltDecryptInvocation } | { ok: false; error: EncryptionError }> {
  const checked = checkDecryptInvocationInput(crypto, input);
  if (!checked.ok) {
    return checked;
  }
  try {
    const built = await signer.signDecryptInvocation(checked.data);
    if (!built.authorization || !built.invocationCid) {
      return {
        ok: false,
        error: encryptionError({
          code: "INVALID_INPUT",
          message:
            "decrypt-invocation signer returned an empty authorization or invocationCid",
        }),
      };
    }
    if (built.canonicalBody !== checked.canonicalBody) {
      return {
        ok: false,
        error: encryptionError({
          code: "INVALID_INPUT",
          message:
            "decrypt-invocation signer returned a canonicalBody that does not match the SDK's canonicalization — signer must use the SDK-provided body",
        }),
      };
    }
    return { ok: true, data: built };
  } catch (err) {
    return {
      ok: false,
      error: encryptionError({
        code: "TRANSPORT_ERROR",
        cause: err instanceof Error ? err : new Error(String(err)),
        message: `failed to sign decrypt invocation: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
    };
  }
}

/** Re-export so callers can introspect the service+action constants. */
export { DECRYPT_ACTION, ENCRYPTION_SERVICE };
