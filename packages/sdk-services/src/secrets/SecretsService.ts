import { ErrorCodes, err, type Result, type ServiceError } from "../types";
import type { IDataVaultService } from "../vault/IDataVaultService";
import type { VaultError } from "../vault/types";
import type {
  ISecretsService,
  SecretCatalogEntry,
  SecretPayload,
  SecretsError,
} from "./ISecretsService";
import {
  canonicalizeSecretScope,
  parseSecretCatalogKey,
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

  async get(
    name: string,
    options?: SecretScopeOptions,
  ): Promise<Result<string, SecretsError>> {
    const secretPath = resolveSecretPathResult(name, options);
    if ("ok" in secretPath) return secretPath;

    const result =
      options?.source === undefined
        ? await this.vault.get<SecretPayload>(secretPath.vaultKey)
        : await this.vault.get<SecretPayload>(secretPath.vaultKey, {
            source: options.source,
          });
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

  async list(
    options?: SecretScopeOptions,
  ): Promise<Result<string[], SecretsError>> {
    let prefix: string;
    try {
      const scope = canonicalizeSecretScope(options?.scope);
      prefix = scope === undefined ? "secrets/" : `secrets/scoped/${scope}/`;
    } catch (error) {
      return invalidSecretInput(
        error instanceof Error ? error.message : String(error),
      );
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
      data: result.data.filter((name) => SECRET_NAME_RE.test(name)),
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
        const entry = parseSecretCatalogKey(key);
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
