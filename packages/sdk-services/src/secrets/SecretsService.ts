import {
  ErrorCodes,
  err,
  type Result,
  type ServiceError,
} from "../types";
import type { IDataVaultService } from "../vault/IDataVaultService";
import type { VaultError } from "../vault/types";
import type {
  ISecretsService,
  SecretPayload,
  SecretsError,
} from "./ISecretsService";
import {
  canonicalizeSecretScope,
  resolveSecretPath,
  SECRET_NAME_RE,
  type ResolvedSecretPath,
  type SecretScopeOptions,
} from "./paths";

function invalidSecretInput(message: string): Result<never, ServiceError> {
  return err({
    code: ErrorCodes.INVALID_INPUT,
    service: "secrets",
    message,
  });
}

function resolveSecretPathResult(
  name: string,
  options?: SecretScopeOptions,
): ResolvedSecretPath | Result<never, ServiceError> {
  try {
    return resolveSecretPath(name, options);
  } catch (error) {
    return invalidSecretInput(error instanceof Error ? error.message : String(error));
  }
}

export class SecretsService implements ISecretsService {
  private readonly getVault: () => IDataVaultService;

  constructor(vault: IDataVaultService | (() => IDataVaultService)) {
    this.getVault = typeof vault === "function" ? vault : () => vault;
  }

  get vault(): IDataVaultService {
    return this.getVault();
  }

  get isUnlocked(): boolean {
    return this.vault.isUnlocked;
  }

  unlock(signer?: unknown): Promise<Result<void, VaultError>> {
    return this.vault.unlock(signer);
  }

  lock(): void {
    this.vault.lock();
  }

  async get(
    name: string,
    options?: SecretScopeOptions,
  ): Promise<Result<string, SecretsError>> {
    const secretPath = resolveSecretPathResult(name, options);
    if ("ok" in secretPath) return secretPath;

    const result = await this.vault.get<SecretPayload>(secretPath.vaultKey);
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: result.data.value.value };
  }

  async put(
    name: string,
    value: string,
    options?: SecretScopeOptions,
  ): Promise<Result<void, SecretsError>> {
    const secretPath = resolveSecretPathResult(name, options);
    if ("ok" in secretPath) return secretPath;

    const now = new Date().toISOString();
    return this.vault.put(secretPath.vaultKey, {
      value,
      createdAt: now,
      updatedAt: now,
    } satisfies SecretPayload);
  }

  async delete(
    name: string,
    options?: SecretScopeOptions,
  ): Promise<Result<void, SecretsError>> {
    const secretPath = resolveSecretPathResult(name, options);
    if ("ok" in secretPath) return secretPath;

    return this.vault.delete(secretPath.vaultKey);
  }

  async list(options?: SecretScopeOptions): Promise<Result<string[], SecretsError>> {
    let prefix: string;
    try {
      const scope = canonicalizeSecretScope(options?.scope);
      prefix = scope === undefined ? "secrets/" : `secrets/scoped/${scope}/`;
    } catch (error) {
      return invalidSecretInput(error instanceof Error ? error.message : String(error));
    }

    const result = await this.vault.list({
      prefix,
      removePrefix: true,
    });
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      data: result.data.filter((name) => SECRET_NAME_RE.test(name)),
    };
  }
}
