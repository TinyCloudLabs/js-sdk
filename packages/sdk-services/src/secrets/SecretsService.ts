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

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SECRET_PREFIX = "secrets/";

function invalidSecretName(name: string): Result<never, ServiceError> {
  return err({
    code: ErrorCodes.INVALID_INPUT,
    service: "secrets",
    message:
      `Invalid secret name ${JSON.stringify(name)}. Secret names must match ${SECRET_NAME_RE.source}.`,
  });
}

function secretKey(name: string): string {
  return `${SECRET_PREFIX}${name}`;
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

  async get(name: string): Promise<Result<string, SecretsError>> {
    if (!SECRET_NAME_RE.test(name)) {
      return invalidSecretName(name);
    }

    const result = await this.vault.get<SecretPayload>(secretKey(name));
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: result.data.value.value };
  }

  async put(name: string, value: string): Promise<Result<void, SecretsError>> {
    if (!SECRET_NAME_RE.test(name)) {
      return invalidSecretName(name);
    }

    const now = new Date().toISOString();
    return this.vault.put(secretKey(name), {
      value,
      createdAt: now,
      updatedAt: now,
    } satisfies SecretPayload);
  }

  async delete(name: string): Promise<Result<void, SecretsError>> {
    if (!SECRET_NAME_RE.test(name)) {
      return invalidSecretName(name);
    }

    return this.vault.delete(secretKey(name));
  }

  async list(): Promise<Result<string[], SecretsError>> {
    const result = await this.vault.list({
      prefix: SECRET_PREFIX,
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
