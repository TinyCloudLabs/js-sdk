import type { IDataVaultService } from "../vault/IDataVaultService";
import type { VaultError } from "../vault/types";
import type { Result, ServiceError } from "../types";
import type { SecretType } from "./secretTypes";
import type { SecretGetOptions, SecretPutOptions, SecretScopeOptions } from "./paths";

export interface SecretPayload {
  value: string;
  createdAt: string;
  updatedAt: string;
  /** Optional kind of secret; absent means `secret`. Readers may ignore it. */
  type?: string;
}

/** A secret with its type resolved for display. */
export interface SecretEntry {
  value: string;
  /** `secret` when the stored payload has no type or an unknown one. */
  type: SecretType;
  createdAt: string;
  updatedAt: string;
}

/** One discoverable secret location. Secret values are never included. */
export interface SecretCatalogEntry {
  name: string;
  /** Omitted for the global secret namespace. */
  scope?: string;
}

export type SecretsError = VaultError | ServiceError;

export interface ISecretsService {
  readonly vault: IDataVaultService;
  unlock(signer?: unknown): Promise<Result<void, VaultError>>;
  lock(): void;
  readonly isUnlocked: boolean;
  get(
    name: string,
    options?: SecretGetOptions,
  ): Promise<Result<string, SecretsError>>;
  /** Like `get`, with the secret's type and timestamps. */
  getEntry(
    name: string,
    options?: SecretGetOptions,
  ): Promise<Result<SecretEntry, SecretsError>>;
  put(
    name: string,
    value: string,
    options?: SecretPutOptions,
  ): Promise<Result<void, SecretsError>>;
  delete(
    name: string,
    options?: SecretScopeOptions,
  ): Promise<Result<void, SecretsError>>;
  list(options?: SecretScopeOptions): Promise<Result<string[], SecretsError>>;
  /** List global and scoped secrets without decrypting their values. */
  listAll(): Promise<Result<SecretCatalogEntry[], SecretsError>>;
}
