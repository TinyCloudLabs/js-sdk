/**
 * TinyCloud encryption service exports.
 *
 * Reference architecture:
 * - Network ids: `urn:tinycloud:encryption:<principal>:<network>`
 * - Inline envelopes: `{ v, networkId, alg, keyVersion,
 *   encryptedSymmetricKey, encryptedSymmetricKeyHash, ciphertext, aad,
 *   metadata }`
 * - Decrypt requests: UCAN-style invocations against a node + networkId.
 */

export { EncryptionService } from "./EncryptionService";
export type {
  DecryptTransport,
  EncryptionServiceConfig,
} from "./EncryptionService";
export type {
  IEncryptionService,
  EncryptToNetworkOptions,
  DecryptEnvelopeOptions,
} from "./IEncryptionService";

export {
  parseNetworkId,
  buildNetworkId,
  isNetworkId,
  networkDiscoveryKey,
  NetworkIdError,
  ENCRYPTION_NETWORK_URN_PREFIX,
  NETWORK_NAME_PATTERN,
  type ParsedNetworkId,
} from "./networkId";

export {
  canonicalize,
  canonicalHashHex,
  hexEncode,
  hexDecode,
  base64Encode,
  base64Decode,
  utf8Encode,
  utf8Decode,
  type Json,
} from "./canonical";

export {
  encryptToNetwork,
  decryptEnvelopeWithKey,
  validateEnvelope,
  type EncryptToNetworkInput,
  type EncryptToNetworkResult,
} from "./envelope";

export {
  generateRandomReceiverKey,
  deriveSignedReceiverKey,
  type RandomReceiverKeyInput,
  type SignedReceiverKeyInput,
} from "./receiverKey";

export {
  buildCanonicalDecryptRequest,
  buildDecryptFacts,
  buildDecryptAttenuation,
  buildDecryptInvocation,
  checkDecryptInvocationInput,
  DECRYPT_ACTION,
  ENCRYPTION_SERVICE,
  type CanonicalDecryptRequest,
  type BuildCanonicalDecryptRequestInput,
  type BuildDecryptFactsInput,
} from "./invocation";

export {
  verifyDecryptResponse,
  canonicalSignedResponse,
  openWrappedKey,
  type VerifyDecryptResponseInput,
} from "./response";

export {
  discoverNetwork,
  ensureNetworkUsableForDecrypt,
  type DiscoverNetworkInput,
  type DiscoveredNetwork,
  type DiscoverySource,
  type NodeDescriptorFetcher,
  type WellKnownDescriptorFetcher,
} from "./discovery";

export {
  DEFAULT_ENCRYPTION_ALG,
  ENVELOPE_VERSION,
  DEFAULT_KEY_VERSION,
  DECRYPT_FACT_TYPE,
  DECRYPT_RESULT_TYPE,
  ENCRYPTION_SERVICE_SHORT,
  encryptionError,
  type BuildDecryptInvocationInput,
  type BuiltDecryptInvocation,
  type CanonicalJson,
  type DecryptCapabilityProof,
  type DecryptInvocationFact,
  type DecryptInvocationSigner,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type EncryptionCrypto,
  type EncryptionError,
  type EncryptionErrorInput,
  type InlineEncryptedEnvelope,
  type NetworkDescriptor,
  type ReceiverKeyPair,
  type ReceiverKeySigner,
} from "./types";
