import { ErrorCodes, err, type Result, type ServiceError } from "../types";
import type { IDataVaultService } from "../vault/IDataVaultService";
import type { VaultError } from "../vault/types";
import type {
  ISecretsService,
  SecretCatalogEntry,
  SecretEntry,
  SecretPayload,
  SecretsError,
} from "./ISecretsService";
import {
  DEFAULT_SECRET_TYPE,
  isSecretType,
  SECRET_TYPES,
  secretTypeOf,
} from "./secretTypes";
import {
  canonicalizeSecretScope,
  isStoredSecretName,
  isStoredTooLongScope,
  parseStoredSecretCatalogKey,
  resolveSecretPath,
  secretNameTooLongRefusal,
  type ResolvedSecretPath,
  type SecretGetOptions,
  type SecretScopeOptions,
  type SecretPutOptions,
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
    return invalidSecretInput(
      error instanceof Error ? error.message : String(error),
    );
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

  private async readPayload(
    name: string,
    options?: SecretGetOptions,
  ): Promise<Result<SecretPayload, SecretsError>> {
    const secretPath = resolveSecretPathResult(name, options);
    if ("ok" in secretPath) return secretPath;

    // A secret opens only from its own key, or from an old network-wrapped
    // copy, and only when bound to this space and name (TC-3284).
    const result = await this.vault.get<SecretPayload>(secretPath.vaultKey, {
      expectAad: true,
      keyPath: secretPath.keyPath,
      ...(options?.source === undefined ? {} : { source: options.source }),
      ...(options?.namedKeyOnly === true ? { namedKeyOnly: true } : {}),
    });
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: result.data.value };
  }

  async get(
    name: string,
    options?: SecretGetOptions,
  ): Promise<Result<string, SecretsError>> {
    const payload = await this.readPayload(name, options);
    if (!payload.ok) return payload;
    return { ok: true, data: payload.data.value };
  }

  async getEntry(
    name: string,
    options?: SecretGetOptions,
  ): Promise<Result<SecretEntry, SecretsError>> {
    const payload = await this.readPayload(name, options);
    if (!payload.ok) return payload;
    const { value, createdAt, updatedAt } = payload.data;
    return {
      ok: true,
      data: { value, type: secretTypeOf(payload.data), createdAt, updatedAt },
    };
  }

  async put(
    name: string,
    value: string,
    options?: SecretPutOptions,
  ): Promise<Result<void, SecretsError>> {
    const tooLong = secretNameTooLongRefusal(name);
    if (tooLong) return tooLong;
    const secretPath = resolveSecretPathResult(name, options);
    if ("ok" in secretPath) return secretPath;
    if (options?.type !== undefined && !isSecretType(options.type)) {
      return invalidSecretInput(
        `Invalid secret type ${JSON.stringify(options.type)}. Use one of: ${SECRET_TYPES.join(", ")}.`,
      );
    }

    const now = new Date().toISOString();
    const payload = {
      value,
      createdAt: now,
      updatedAt: now,
      ...(options?.type === undefined || options.type === DEFAULT_SECRET_TYPE
        ? {}
        : { type: options.type }),
    } satisfies SecretPayload;
    return this.vault.put(secretPath.vaultKey, payload, {
      ...(options?.namedKey === true ? { keyPath: secretPath.keyPath } : {}),
      ...(options?.ifAbsent === true ? { ifNoneMatch: "*" } : {}),
    });
  }

  async delete(
    name: string,
    options?: SecretScopeOptions,
  ): Promise<Result<void, SecretsError>> {
    const secretPath = resolveSecretPathResult(name, options);
    if ("ok" in secretPath) return secretPath;

    return this.vault.delete(secretPath.vaultKey);
  }

  async list(
    options?: SecretScopeOptions,
  ): Promise<Result<string[], SecretsError>> {
    let prefix: string;
    const stored = options?.scope?.trim();
    if (stored !== undefined && isStoredTooLongScope(stored)) {
      // A scope stored before the length limit is still listed; nothing can get, put or delete under it.
      prefix = `secrets/scoped/${stored}/`;
    } else {
      try {
        const scope = canonicalizeSecretScope(options?.scope);
        prefix = scope === undefined ? "secrets/" : `secrets/scoped/${scope}/`;
      } catch (error) {
        return invalidSecretInput(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const result = await this.vault.list({
      prefix,
      removePrefix: true,
      ...(options?.source === undefined ? {} : { source: options.source }),
    });
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      data: result.data.filter((name) => isStoredSecretName(name)),
    };
  }

  async listAll(): Promise<Result<SecretCatalogEntry[], SecretsError>> {
    const entries = new Map<string, SecretCatalogEntry>();
    // A node older than bounded list paging ignores the cursor and returns the
    // same page again; a repeated cursor would loop forever, so it fails.
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const result = await this.vault.listPage({
        prefix: "secrets/",
        removePrefix: true,
        limit: 1000,
        source: "network",
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!result.ok) {
        return result;
      }

      for (const key of result.data.keys) {
        const entry = parseStoredSecretCatalogKey(key);
        if (!entry) continue;
        entries.set(`${entry.scope ?? ""}\u0000${entry.name}`, entry);
      }

      cursor = result.data.truncated ? result.data.nextCursor : undefined;
      if (result.data.truncated && cursor === undefined) {
        return invalidSecretInput(
          "Secret catalog listing was truncated without a continuation cursor.",
        );
      }
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          return invalidSecretInput(
            "Secret catalog listing repeated a continuation cursor; the node does not support paged KV lists.",
          );
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);

    return {
      ok: true,
      data: [...entries.values()].sort(
        (a, b) =>
          (a.scope ?? "").localeCompare(b.scope ?? "") ||
          a.name.localeCompare(b.name),
      ),
    };
  }
}
