/**
 * IEncryptionService - Interface for the TinyCloud encryption service.
 *
 * Provides:
 * - Network discovery
 * - Local encrypt-to-network (no node round-trip)
 * - Node-mediated decrypt (one-of-one or threshold; v1 is one-of-one)
 *
 * The service does NOT own KV/SQL access. Callers fetch encrypted
 * envelopes from their data service of choice and pass them in.
 */

import type { IService, Result } from "../types";
import type {
  DecryptCapabilityProof,
  EncryptionError,
  InlineEncryptedEnvelope,
  NetworkDescriptor,
} from "./types";

export interface EncryptToNetworkOptions {
  /** Optional associated authenticated data (bytes). */
  aad?: Uint8Array;
  /** Ciphersuite override. Defaults to the network's alg. */
  alg?: string;
  /** Key version override. Defaults to the network's current key version. */
  keyVersion?: number;
  /** Caller-supplied envelope metadata. */
  metadata?: Record<string, string>;
}

export interface DecryptEnvelopeOptions {
  /**
   * Pre-discovered descriptor for the envelope's network. When omitted
   * the service performs discovery internally.
   */
  descriptor?: NetworkDescriptor;
  /** Optional associated data; must match what was used at encryption time. */
  aad?: Uint8Array;
  /** Override the target node id when the descriptor advertises many. */
  targetNode?: string;
}

export interface IEncryptionService extends IService {
  /**
   * Look up a network's descriptor.
   *
   * `identifier` may be either a full networkId URN
   * (`urn:tinycloud:encryption:did:key:...:default`) or a bare network
   * name. The bare name form requires the principal to be supplied via
   * `principal`.
   */
  discoverNetwork(
    identifier: string,
    principal?: string,
  ): Promise<Result<NetworkDescriptor, EncryptionError>>;

  /**
   * Encrypt plaintext to the network's public key locally. The result
   * is an inline envelope ready to persist (KV/SQL).
   */
  encryptToNetwork(
    networkId: string,
    plaintext: Uint8Array,
    options?: EncryptToNetworkOptions,
  ): Promise<Result<InlineEncryptedEnvelope, EncryptionError>>;

  /**
   * Decrypt an inline envelope via the node.
   *
   * Steps: generate per-request receiver key, build & sign the
   * decrypt invocation, POST it to the node, verify the signed
   * response, open `wrappedKey`, and decrypt the payload locally.
   *
   * The capability proof must root at the network principal embedded
   * in the envelope's networkId.
   */
  decryptEnvelope(
    envelope: InlineEncryptedEnvelope,
    capabilityProof: DecryptCapabilityProof,
    options?: DecryptEnvelopeOptions,
  ): Promise<Result<Uint8Array, EncryptionError>>;
}
