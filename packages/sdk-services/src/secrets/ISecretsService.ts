import type { IDataVaultService } from "../vault/IDataVaultService";
import type { VaultError } from "../vault/types";
import type { Result, ServiceError } from "../types";
import type { SecretScopeOptions } from "./paths";

export interface SecretPayload {
  value: string;
  createdAt: string;
  updatedAt: string;
}

export type SecretsError = VaultError | ServiceError;

export interface ISecretsService {
  readonly vault: IDataVaultService;
  unlock(signer?: unknown): Promise<Result<void, VaultError>>;
  lock(): void;
  readonly isUnlocked: boolean;
  get(name: string, options?: SecretScopeOptions): Promise<Result<string, SecretsError>>;
  put(name: string, value: string, options?: SecretScopeOptions): Promise<Result<void, SecretsError>>;
  delete(name: string, options?: SecretScopeOptions): Promise<Result<void, SecretsError>>;
  list(options?: SecretScopeOptions): Promise<Result<string[], SecretsError>>;
}
