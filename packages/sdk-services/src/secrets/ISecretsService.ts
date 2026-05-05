import type { IDataVaultService } from "../vault/IDataVaultService";
import type { VaultError } from "../vault/types";
import type { Result, ServiceError } from "../types";

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
  get(name: string): Promise<Result<string, SecretsError>>;
  put(name: string, value: string): Promise<Result<void, SecretsError>>;
  delete(name: string): Promise<Result<void, SecretsError>>;
  list(): Promise<Result<string[], SecretsError>>;
}
