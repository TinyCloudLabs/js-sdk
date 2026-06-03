/**
 * Decrypt-response verification.
 *
 * The node returns the unwrapped symmetric key re-encrypted to the
 * per-request receiver public key. Before the SDK uses the wrapped
 * key, it must:
 *
 * 1. Verify the node signature over the canonical response (excluding
 *    the signature field).
 * 2. Recompute every binding hash and reject any mismatch.
 * 3. Confirm `targetNode`, `networkId`, `alg`, and `keyVersion` echo
 *    what the SDK sent.
 *
 * After verification, the SDK opens `wrappedKey` with the per-request
 * receiver private key and uses the resulting symmetric key to
 * decrypt the inline envelope payload.
 */

import { base64Decode, canonicalize, hexEncode, utf8Encode } from "./canonical";
import {
  DECRYPT_RESULT_TYPE,
  encryptionError,
  type CanonicalJson,
  type DecryptInvocationFact,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type EncryptionCrypto,
  type EncryptionError,
} from "./types";

/**
 * Construct the canonical bytes that the node signed.
 *
 * The signature covers the response with `nodeSignature` removed. We
 * canonicalize and hash the same way the node does so the binding is
 * stable.
 */
export function canonicalSignedResponse(
  response: DecryptResponseBody,
): string {
  // Strip the signature; canonicalize sorts keys for us.
  const { nodeSignature: _drop, ...rest } = response;
  return canonicalize(rest as unknown as CanonicalJson);
}

export interface VerifyDecryptResponseInput {
  crypto: EncryptionCrypto;
  request: DecryptRequestBody;
  facts: DecryptInvocationFact;
  /** CID of the signed invocation that produced this response. */
  invocationCid: string;
  /** Hex bodyHash that was bound in `facts.bodyHash`. */
  requestBodyHash: string;
  response: DecryptResponseBody;
}

/**
 * Verify the node's decrypt response. Returns the response on success;
 * a structured error on signature, binding, or shape failure.
 */
export function verifyDecryptResponse(
  input: VerifyDecryptResponseInput,
):
  | { ok: true; data: DecryptResponseBody }
  | { ok: false; error: EncryptionError } {
  const { crypto, request, facts, invocationCid, requestBodyHash, response } =
    input;

  if (response.type !== DECRYPT_RESULT_TYPE) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_RESPONSE",
        message: `response.type must be ${DECRYPT_RESULT_TYPE}`,
      }),
    };
  }
  if (response.targetNode !== request.targetNode) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "targetNode",
      }),
    };
  }
  if (response.networkId !== request.networkId) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "networkId",
      }),
    };
  }
  if (response.alg !== request.alg) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "alg",
      }),
    };
  }
  if (response.keyVersion !== request.keyVersion) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "keyVersion",
      }),
    };
  }
  if (
    response.encryptedSymmetricKeyHash !==
    request.encryptedSymmetricKeyHash
  ) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "encryptedSymmetricKeyHash",
      }),
    };
  }
  if (response.receiverPublicKeyHash !== request.receiverPublicKeyHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "receiverPublicKeyHash",
      }),
    };
  }
  if (response.invocationCid !== invocationCid) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "invocationCid",
      }),
    };
  }
  // requestHash binds invocationCid || requestBodyHash per spec. The `||`
  // notation is concatenation, not a literal delimiter.
  const expectedRequestHash = hexEncode(
    crypto.sha256(utf8Encode(`${invocationCid}${requestBodyHash}`)),
  );
  if (response.requestHash !== expectedRequestHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "requestHash",
      }),
    };
  }
  // The facts must agree with the response (defensive: catches a node
  // that returns a fresh body bound to a different invocation).
  if (
    facts.encryptedSymmetricKeyHash !== response.encryptedSymmetricKeyHash ||
    facts.receiverPublicKeyHash !== response.receiverPublicKeyHash ||
    facts.networkId !== response.networkId ||
    facts.targetNode !== response.targetNode ||
    facts.alg !== response.alg ||
    facts.keyVersion !== response.keyVersion
  ) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "facts",
      }),
    };
  }

  const signedBytes = new TextEncoder().encode(
    canonicalSignedResponse(response),
  );
  const signatureBytes = base64Decode(response.nodeSignature);
  if (
    !crypto.verifyNodeSignature(response.nodeId, signedBytes, signatureBytes)
  ) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_SIGNATURE_INVALID",
      }),
    };
  }
  return { ok: true, data: response };
}

/**
 * After verification, open the response's `wrappedKey` with the
 * per-request receiver private key and return the symmetric key.
 */
export function openWrappedKey(
  crypto: EncryptionCrypto,
  receiverPrivateKey: Uint8Array,
  response: DecryptResponseBody,
): Uint8Array {
  const wrapped = base64Decode(response.wrappedKey);
  return crypto.openWithReceiverKey(receiverPrivateKey, wrapped);
}
