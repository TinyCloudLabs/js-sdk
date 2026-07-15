import type {
  IDataVaultService,
  IServiceContext,
  Result,
  ServiceSession,
  VaultEntry,
  VaultError,
  VaultGetOptions,
  VaultGrantOptions,
  VaultListOptions,
  VaultPutOptions,
} from "@tinycloud/sdk-core";
import type {
  SecretReadInput as NodeSecretReadInput,
  SecretReadResult as NodeSecretReadResult,
} from "@tinycloud/node-sdk";
import type {
  SecretReadInput as NodeCoreSecretReadInput,
  SecretReadResult as NodeCoreSecretReadResult,
} from "@tinycloud/node-sdk/core";
import type {
  SecretReadInput as WebSecretReadInput,
  SecretReadResult as WebSecretReadResult,
} from "@tinycloud/web-sdk";

type _InputExports = [
  NodeSecretReadInput,
  NodeCoreSecretReadInput,
  WebSecretReadInput,
];
type _ResultExports = [
  NodeSecretReadResult,
  NodeCoreSecretReadResult,
  WebSecretReadResult,
];

const success = <T>(data: T): Result<T, VaultError> => ({ ok: true, data });

/** A pre-I3 external vault implementation: no classified-read method. */
class LegacyVault implements IDataVaultService {
  readonly config = {};
  readonly isUnlocked = false;
  readonly publicKey = new Uint8Array();

  initialize(_context: IServiceContext): void {}
  onSessionChange(_session: ServiceSession | null): void {}
  onSignOut(): void {}
  async unlock(_signer?: unknown): Promise<Result<void, VaultError>> {
    return success(undefined);
  }
  async clearCache(_spaceId?: string): Promise<void> {}
  lock(): void {}
  async put(
    _key: string,
    _value: unknown,
    _options?: VaultPutOptions,
  ): Promise<Result<void, VaultError>> {
    return success(undefined);
  }
  async get<T = unknown>(
    _key: string,
    _options?: VaultGetOptions<T>,
  ): Promise<Result<VaultEntry<T>, VaultError>> {
    return success({ value: undefined as T, metadata: {}, keyId: "legacy" });
  }
  async delete(_key: string): Promise<Result<void, VaultError>> {
    return success(undefined);
  }
  async list(_options?: VaultListOptions): Promise<Result<string[], VaultError>> {
    return success([]);
  }
  async head(_key: string): Promise<Result<Record<string, string>, VaultError>> {
    return success({});
  }
  async putMany(
    _entries: Array<{ key: string; value: unknown; options?: VaultPutOptions }>,
  ): Promise<Result<void, VaultError>[]> {
    return [];
  }
  async getMany<T = unknown>(
    _keys: string[],
    _options?: VaultGetOptions<T>,
  ): Promise<Result<VaultEntry<T>, VaultError>[]> {
    return [];
  }
  async grant(
    _key: string,
    _recipientDid: string,
    _options?: VaultGrantOptions,
  ): Promise<Result<void, VaultError>> {
    return success(undefined);
  }
  async reencrypt(
    _key: string,
    _recipientDid: string,
    _options?: VaultGrantOptions,
  ): Promise<Result<void, VaultError>> {
    return success(undefined);
  }
  async revoke(_key: string, _recipientDid: string): Promise<Result<void, VaultError>> {
    return success(undefined);
  }
  async listGrants(_key: string): Promise<Result<string[], VaultError>> {
    return success([]);
  }
  async getShared<T = unknown>(
    _grantorDid: string,
    _key: string,
    _options?: VaultGetOptions<T>,
  ): Promise<Result<VaultEntry<T>, VaultError>> {
    return success({ value: undefined as T, metadata: {}, keyId: "legacy" });
  }
  async resolvePublicKey(_did: string): Promise<Result<Uint8Array, VaultError>> {
    return success(new Uint8Array());
  }
}

void (new LegacyVault());
void (null as unknown as _InputExports);
void (null as unknown as _ResultExports);
