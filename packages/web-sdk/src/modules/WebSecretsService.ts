import {
  ErrorCodes,
  resolveSecretPath,
  resolveManifest,
  type IDataVaultService,
  type ISecretsService,
  type Manifest,
  type PermissionEntry,
  type Result,
  type SecretScopeOptions,
  type ServiceError,
} from "@tinycloud/sdk-core";
import type { VaultError } from "@tinycloud/sdk-core";

type RequestPermissions = (
  additional: PermissionEntry[],
) => Promise<{ approved: boolean; delegations?: readonly unknown[] }>;

const SECRETS_SPACE = "secrets";

function ok(): Result<void, ServiceError> {
  return { ok: true, data: undefined };
}

function secretsError(
  code: string,
  message: string,
  cause?: Error,
): Result<never, ServiceError> {
  return {
    ok: false,
    error: {
      code,
      service: "secrets",
      message,
      ...(cause ? { cause } : {}),
    },
  };
}

function displayActionUrn(action: "put" | "del"): string {
  return action === "put" ? "tinycloud.kv/put" : "tinycloud.kv/del";
}

function kvActionUrn(action: "put" | "del"): string {
  return `tinycloud.kv/${action}`;
}

function secretPermissionEntries(
  name: string,
  options: SecretScopeOptions | undefined,
  action: "put" | "del",
  space: string,
): PermissionEntry[] {
  const secretPath = resolveSecretPath(name, options);
  return [
    {
      service: "tinycloud.kv",
      space,
      path: secretPath.permissionPaths.vault,
      actions: [action],
      skipPrefix: true,
    },
  ];
}

function normalizeSpace(space: string | undefined, resolveSpace?: (space: string) => string): string | undefined {
  if (!space) return undefined;
  if (space.startsWith("tinycloud:")) return space;
  return resolveSpace?.(space) ?? space;
}

function spaceMatches(
  granted: string | undefined,
  requested: string | undefined,
  resolveSpace?: (space: string) => string,
): boolean {
  if (!granted || !requested) return false;
  return normalizeSpace(granted, resolveSpace) === normalizeSpace(requested, resolveSpace);
}

export interface WebSecretsServiceConfig {
  getService: () => ISecretsService;
  space?: string;
  getManifest: () => Manifest | Manifest[] | undefined;
  requestPermissions: RequestPermissions;
  resolveSpace?: (space: string) => string;
  getUnlockSigner?: () => unknown;
}

export class WebSecretsService implements ISecretsService {
  private unlockSigner?: unknown;
  private shouldRestoreUnlock = false;

  constructor(private readonly config: WebSecretsServiceConfig) {}

  private get space(): string {
    return this.config.space ?? SECRETS_SPACE;
  }

  get vault(): IDataVaultService {
    return this.service.vault;
  }

  get isUnlocked(): boolean {
    return this.service.isUnlocked;
  }

  async unlock(signer?: unknown): Promise<Result<void, VaultError>> {
    const effectiveSigner = signer ?? this.config.getUnlockSigner?.();
    if (effectiveSigner !== undefined) {
      this.unlockSigner = effectiveSigner;
    }
    const result = await this.service.unlock(effectiveSigner);
    if (result.ok) {
      this.shouldRestoreUnlock = true;
    }
    return result;
  }

  lock(): void {
    this.shouldRestoreUnlock = false;
    this.service.lock();
  }

  get(name: string, options?: SecretScopeOptions): ReturnType<ISecretsService["get"]> {
    return options === undefined
      ? this.service.get(name)
      : this.service.get(name, options);
  }

  async put(
    name: string,
    value: string,
    options?: SecretScopeOptions,
  ): ReturnType<ISecretsService["put"]> {
    const permission = await this.ensureMutationPermission(name, options, "put");
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.put(name, value)
      : this.service.put(name, value, options);
  }

  async delete(
    name: string,
    options?: SecretScopeOptions,
  ): ReturnType<ISecretsService["delete"]> {
    const permission = await this.ensureMutationPermission(name, options, "del");
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.delete(name)
      : this.service.delete(name, options);
  }

  list(options?: SecretScopeOptions): ReturnType<ISecretsService["list"]> {
    return options === undefined
      ? this.service.list()
      : this.service.list(options);
  }

  private get service(): ISecretsService {
    return this.config.getService();
  }

  private async ensureMutationPermission(
    name: string,
    options: SecretScopeOptions | undefined,
    action: "put" | "del",
  ): Promise<Result<void, ServiceError | VaultError>> {
    let permissionEntries: PermissionEntry[];
    try {
      permissionEntries = secretPermissionEntries(name, options, action, this.space);
    } catch (error) {
      return secretsError(
        ErrorCodes.INVALID_INPUT,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error : undefined,
      );
    }

    if (this.hasMutationPermission(name, options, action)) {
      return ok();
    }

    try {
      const result = await this.config.requestPermissions(
        permissionEntries,
      );
      if (!result.approved) {
        return secretsError(
          ErrorCodes.PERMISSION_DENIED,
          `Permission request for ${displayActionUrn(action)} on ${name} was declined.`,
        );
      }
      return this.restoreUnlockAfterEscalation();
    } catch (error) {
      return secretsError(
        ErrorCodes.PERMISSION_DENIED,
        error instanceof Error
          ? error.message
          : `Permission request for ${displayActionUrn(action)} on ${name} failed.`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async restoreUnlockAfterEscalation(): Promise<
    Result<void, ServiceError | VaultError>
  > {
    if (!this.shouldRestoreUnlock) {
      return ok();
    }
    return this.service.unlock(this.unlockSigner);
  }

  private hasMutationPermission(
    name: string,
    options: SecretScopeOptions | undefined,
    action: "put" | "del",
  ): boolean {
    const manifest = this.config.getManifest();
    if (manifest === undefined) {
      return false;
    }

    const manifests = Array.isArray(manifest) ? manifest : [manifest];
    const requiredAction = kvActionUrn(action);
    const secretPath = resolveSecretPath(name, options);
    return manifests.some((entry) => {
      const resolved = resolveManifest(entry);
      return resolved.resources.some(
        (resource) =>
          resource.service === "tinycloud.kv" &&
          spaceMatches(resource.space, this.space, this.config.resolveSpace) &&
          resource.path === secretPath.permissionPaths.vault &&
          resource.actions.includes(requiredAction),
      );
    });
  }
}
