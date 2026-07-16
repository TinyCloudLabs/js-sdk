/**
 * EncryptionService — TinyCloud one-of-one encryption service.
 *
 * Responsibilities:
 * - Network discovery (`discoverNetwork`).
 * - Local envelope encryption (`encryptToNetwork`).
 * - Node-mediated decrypt with full request/response binding
 *   verification (`decryptEnvelope`).
 *
 * Non-responsibilities:
 * - KV/SQL access. Callers fetch encrypted envelopes from their data
 *   service of choice and pass them in.
 * - Network onboarding/ceremony. Those routes are node-only.
 */

import { BaseService } from "../base/BaseService";
import { type Result } from "../types";
import {
  base64Decode,
  base64Encode,
  canonicalHashHex,
} from "./canonical";
import {
  discoverNetwork as discoverNetworkFn,
  ensureNetworkUsableForDecrypt,
  type NodeDescriptorFetcher,
  type WellKnownDescriptorFetcher,
} from "./discovery";
import {
  decryptEnvelopeWithKey,
  encryptToNetwork as encryptToNetworkFn,
  validateEnvelope,
} from "./envelope";
import {
  buildCanonicalDecryptRequest,
  buildDecryptFacts,
  buildDecryptInvocation,
} from "./invocation";
import { generateRandomReceiverKey } from "./receiverKey";
import {
  openWrappedKey,
  verifyDecryptResponse,
} from "./response";
import { DecryptTransportResponseError } from "@tinycloud/sdk-services/internal/decrypt-transport-response-error";
import {
  DECRYPT_FACT_TYPE,
  encryptionError,
  type DecryptCapabilityProof,
  type DecryptInvocationSigner,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type EncryptionCrypto,
  type EncryptionError,
  type InlineEncryptedEnvelope,
  type NetworkDescriptor,
  toError,
} from "./types";
import type {
  EncryptToNetworkOptions,
  DecryptEnvelopeOptions,
  IEncryptionService,
} from "./IEncryptionService";

// Local Result helpers typed to EncryptionError. The shared `ok` / `err`
// from `../types` default the error generic to `ServiceError`, which
// widens our return-type inference here.
function encOk<T>(data: T): Result<T, EncryptionError> {
  return { ok: true, data };
}
function encErr<T = never>(error: EncryptionError): Result<T, EncryptionError> {
  return { ok: false, error };
}

/**
 * Transport for posting decrypt requests to a TinyCloud node.
 *
 * Implementations supply the `Authorization` header (built by the
 * decrypt-invocation signer) and POST the canonical body. The
 * response body is JSON-decoded into a {@link DecryptResponseBody}.
 */
export interface DecryptTransport {
  postDecrypt(input: {
    targetNode: string;
    networkId: string;
    authorization: string;
    canonicalBody: string;
    signal?: AbortSignal;
  }): Promise<DecryptResponseBody>;
}

export { DecryptTransportResponseError } from "@tinycloud/sdk-services/internal/decrypt-transport-response-error";

export interface EncryptionServiceConfig {
  crypto: EncryptionCrypto;
  signer: DecryptInvocationSigner;
  transport: DecryptTransport;
  node?: NodeDescriptorFetcher;
  wellKnown?: WellKnownDescriptorFetcher;
  /** Bound by an owning service graph to prevent cross-session authority use. */
  assertActive?: () => void;
  [key: string]: unknown;
}

export class EncryptionService
  extends BaseService
  implements IEncryptionService
{
  static readonly serviceName = "encryption";

  declare protected _config: EncryptionServiceConfig;

  constructor(config: EncryptionServiceConfig) {
    super();
    this._config = config;
  }

  get config(): EncryptionServiceConfig {
    return this._config;
  }

  private get crypto(): EncryptionCrypto {
    return this._config.crypto;
  }

  async discoverNetwork(
    identifier: string,
    ownerDid?: string,
  ): Promise<Result<NetworkDescriptor, EncryptionError>> {
    this.assertActive();
    const result = await discoverNetworkFn({
      identifier,
      ...(ownerDid !== undefined ? { ownerDid } : {}),
      ...(this._config.node !== undefined ? { node: this._config.node } : {}),
      ...(this._config.wellKnown !== undefined
        ? { wellKnown: this._config.wellKnown }
        : {}),
    });
    this.assertActive();
    if (!result.ok) return result;
    return encOk(result.data.descriptor);
  }

  async encryptToNetwork(
    networkId: string,
    plaintext: Uint8Array,
    options?: EncryptToNetworkOptions,
  ): Promise<Result<InlineEncryptedEnvelope, EncryptionError>> {
    try {
      this.assertActive();
      const discovered = await this.discoverNetwork(networkId);
      if (!discovered.ok) return discovered;
      const usable = ensureNetworkUsableForDecrypt(discovered.data);
      // For encryption we tolerate "rotating" but reject revoked/failed/pending —
      // ensureNetworkUsableForDecrypt enforces exactly that constraint.
      if (!usable.ok) return usable;

      const descriptor = usable.data;
      const networkPublicKey = base64Decode(descriptor.publicEncryptionKey);
      const result = encryptToNetworkFn(this.crypto, {
        networkId,
        networkPublicKey,
        plaintext,
        ...(options?.aad !== undefined ? { aad: options.aad } : {}),
        alg: options?.alg ?? descriptor.alg,
        keyVersion: options?.keyVersion ?? descriptor.keyVersion,
        ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
      });
      return encOk(result.envelope);
    } catch (error) {
      return encErr(
        encryptionError({
          code: "TRANSPORT_ERROR",
          cause: toError(error),
        }),
      );
    }
  }

  async decryptEnvelope(
    envelope: InlineEncryptedEnvelope,
    capabilityProof: DecryptCapabilityProof,
    options?: DecryptEnvelopeOptions,
  ): Promise<Result<Uint8Array, EncryptionError>> {
    try {
      this.assertActive();
      const validated = validateEnvelope(this.crypto, envelope);
      if (!validated.ok) return validated;
      if (
        options?.aad !== undefined &&
        validated.data.aad !== base64Encode(options.aad)
      ) {
        return encErr(
          encryptionError({
            code: "INVALID_INPUT",
            message: "decryptEnvelope aad does not match the envelope",
          }),
        );
      }

      let descriptor: NetworkDescriptor;
      if (options?.descriptor !== undefined) {
        descriptor = options.descriptor;
      } else {
        const discovered = await this.discoverNetwork(envelope.networkId);
        if (!discovered.ok) return discovered;
        descriptor = discovered.data;
      }
      const usable = ensureNetworkUsableForDecrypt(descriptor);
      if (!usable.ok) return usable;

      const targetNode =
        options?.targetNode ?? descriptor.members[0]?.nodeId;
      if (targetNode === undefined) {
        return encErr(
          encryptionError({
            code: "INVALID_INPUT",
            message: "no target node available from descriptor",
          }),
        );
      }

      // Generate per-request receiver key. We use the random mode by
      // default; callers wanting deterministic derivation must wrap
      // this service directly.
      const receiverKey = generateRandomReceiverKey({ crypto: this.crypto });
      const receiverPublicKey = base64Encode(receiverKey.publicKey);
      const receiverPublicKeyHash = canonicalHashHex(
        this.crypto.sha256,
        receiverPublicKey,
      );

      const body: DecryptRequestBody = {
        type: DECRYPT_FACT_TYPE,
        targetNode,
        networkId: envelope.networkId,
        alg: envelope.alg,
        keyVersion: envelope.keyVersion,
        encryptedSymmetricKey: envelope.encryptedSymmetricKey,
        encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash,
        receiverPublicKey,
        receiverPublicKeyHash,
      };
      const canonicalRequest = buildCanonicalDecryptRequest({
        crypto: this.crypto,
        body,
        receiverPublicKey: receiverKey.publicKey,
      });
      const facts = buildDecryptFacts({
        crypto: this.crypto,
        body,
        encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash,
        receiverPublicKey: receiverKey.publicKey,
        canonicalBody: canonicalRequest.canonicalBody,
      });

      const built = await buildDecryptInvocation(this.crypto, this._config.signer, {
        targetNode,
        networkId: envelope.networkId,
        body,
        facts,
        proof: capabilityProof,
      });
      this.assertActive();
      if (!built.ok) {
        if (built.error.code !== "TRANSPORT_ERROR") return built;
        return encErr(
          encryptionError({
            code: "INVALID_INPUT",
            message: "Unable to build decrypt request",
          }),
        );
      }

      let response: DecryptResponseBody;
      try {
        response = await this._config.transport.postDecrypt({
          targetNode,
          networkId: envelope.networkId,
          authorization: built.data.authorization,
          canonicalBody: built.data.canonicalBody,
          signal: this.abortSignal,
        });
        this.assertActive();
      } catch (error) {
        if (error instanceof DecryptTransportResponseError) {
          return encErr(
            encryptionError(
              error.status === 401 || error.status === 403
                ? { code: "DECRYPT_DENIED", message: "Node denied decrypt request" }
                : { code: "INVALID_RESPONSE", message: "Node decrypt request failed" },
            ),
          );
        }
        return encErr(
          encryptionError({
            code: "TRANSPORT_ERROR",
            cause: toError(error),
          }),
        );
      }

      const verified = verifyDecryptResponse({
        crypto: this.crypto,
        request: body,
        facts,
        invocationCid: built.data.invocationCid,
        requestBodyHash: facts.bodyHash,
        response,
      });
      if (!verified.ok) return verified;

      const symmetricKey = openWrappedKey(
        this.crypto,
        receiverKey.privateKey,
        verified.data,
      );
      const plaintext = decryptEnvelopeWithKey(
        this.crypto,
        envelope,
        symmetricKey,
      );
      return encOk(plaintext);
    } catch (error) {
      return encErr(
        encryptionError({
          code: "INVALID_RESPONSE",
          message: "Local decryption failed",
        }),
      );
    }
  }

  private assertActive(): void {
    this._config.assertActive?.();
  }
}
