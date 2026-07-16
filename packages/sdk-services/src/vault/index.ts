/**
 * Vault Service Exports
 *
 * Encrypted key-value storage service for TinyCloud SDK.
 */

// Interface
export type { IDataVaultService } from "./IDataVaultService";

// Implementation
export { DataVaultService, type VaultCrypto } from "./DataVaultService";

// Types
export {
  VaultHeaders,
  VaultPublicSpaceKVActions,
  VaultVersionConfig,
  CURRENT_VAULT_VERSION,
  type DataVaultConfig,
  type VaultPutOptions,
  type VaultGetOptions,
  type VaultListOptions,
  type VaultGrantOptions,
  type VaultEntry,
  type VaultNetworkReadResult,
  type VaultError,
} from "./types";

export { createVaultCrypto, type WasmVaultFunctions } from "./createVaultCrypto";

export { clearSignatureCache } from "./SignatureCache";
