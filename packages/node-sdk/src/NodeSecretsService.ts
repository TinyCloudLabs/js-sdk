import {
  ErrorCodes,
  resolveSecretListPrefix,
  resolveSecretPath,
  expandPermissionEntries,
  resolveManifest,
  type IDataVaultService,
  type ISecretsService,
  type Manifest,
  type PermissionEntry,
  type Result,
  type SecretScopeOptions,
  type ServiceError,
  type VaultError,
} from "@tinycloud/sdk-core";

const SECRETS_SPACE = "secrets";
type SecretAction = "get" | "put" | "del" | "list";

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

function displayActionUrn(action: SecretAction): string {
  switch (action) {
    case "get":
      return "tinycloud.kv/get";
    case "put":
      return "tinycloud.kv/put";
    case "del":
      return "tinycloud.kv/del";
    case "list":
      return "tinycloud.kv/list";
  }
}

function secretActionName(action: SecretAction): "get" | "put" | "del" | "list" {
  return action;
}

function secretPermissionEntries(
  name: string,
  options: SecretScopeOptions | undefined,
  action: SecretAction,
  space: string,
  encryptionNetworkId?: string,
): PermissionEntry[] {
  const entries: PermissionEntry[] = [];
  const path =
    action === "list"
      ? resolveSecretListPrefix(options)
      : resolveSecretPath(name, options).permissionPaths.vault;

  entries.push({
    service: "tinycloud.kv",
    space,
    path,
    actions: [secretActionName(action)],
    skipPrefix: true,
  });

  if (action === "get" && encryptionNetworkId !== undefined) {
    entries.push({
      service: "tinycloud.encryption",
      path: encryptionNetworkId,
      actions: ["decrypt"],
      skipPrefix: true,
    });
  }

  return entries;
}

function spaceMatches(granted: string | undefined, requested: string | undefined): boolean {
  if (!granted || !requested) return false;
  if (granted === requested) return true;
  if (!granted.startsWith("tinycloud:") && requested.endsWith(`:${granted}`)) return true;
  if (!requested.startsWith("tinycloud:") && granted.endsWith(`:${requested}`)) return true;
  return false;
}

export interface NodeSecretsServiceConfig {
  getService: () => ISecretsService;
  space?: string;
  getManifest: () => Manifest | Manifest[] | undefined;
  hasPermissions?: (permissions: PermissionEntry[]) => boolean;
  grantPermissions: (additional: PermissionEntry[]) => Promise<unknown>;
  canEscalate: () => boolean;
  getEncryptionNetworkId?: () => string;
  getUnlockSigner?: () => unknown;
}

export class NodeSecretsService implements ISecretsService {
  private unlockSigner?: unknown;
  private shouldRestoreUnlock = false;

  constructor(private readonly config: NodeSecretsServiceConfig) {}

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

  async get(name: string, options?: SecretScopeOptions): ReturnType<ISecretsService["get"]> {
    const permission = await this.ensurePermission(name, options, "get");
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.get(name)
      : this.service.get(name, options);
  }

  async put(
    name: string,
    value: string,
    options?: SecretScopeOptions,
  ): ReturnType<ISecretsService["put"]> {
    const permission = await this.ensurePermission(name, options, "put");
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.put(name, value)
      : this.service.put(name, value, options);
  }

  async delete(
    name: string,
    options?: SecretScopeOptions,
  ): ReturnType<ISecretsService["delete"]> {
    const permission = await this.ensurePermission(name, options, "del");
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.delete(name)
      : this.service.delete(name, options);
  }

  async list(options?: SecretScopeOptions): ReturnType<ISecretsService["list"]> {
    const permission = await this.ensurePermission("", options, "list");
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.list()
      : this.service.list(options);
  }

  private get service(): ISecretsService {
    return this.config.getService();
  }

  private async ensurePermission(
    name: string,
    options: SecretScopeOptions | undefined,
    action: SecretAction,
  ): Promise<Result<void, ServiceError | VaultError>> {
    const target = name || "secrets";
    let permissionEntries: PermissionEntry[];
    try {
      permissionEntries = secretPermissionEntries(
        name,
        options,
        action,
        this.space,
        action === "get" ? this.config.getEncryptionNetworkId?.() : undefined,
      );
    } catch (error) {
      return secretsError(
        ErrorCodes.INVALID_INPUT,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error : undefined,
      );
    }

    if (this.hasPermission(permissionEntries)) {
      return ok();
    }

    if (!this.config.canEscalate()) {
      return secretsError(
        ErrorCodes.PERMISSION_DENIED,
        `Cannot autosign ${displayActionUrn(action)} for ${target}; TinyCloudNode needs wallet mode with a signer or privateKey.`,
      );
    }

    try {
      await this.config.grantPermissions(permissionEntries);
      return this.restoreUnlockAfterEscalation();
    } catch (error) {
      return secretsError(
        ErrorCodes.PERMISSION_DENIED,
        error instanceof Error
          ? error.message
          : `Autosign escalation for ${displayActionUrn(action)} on ${target} failed.`,
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

  private hasPermission(
    permissionEntries: PermissionEntry[],
  ): boolean {
    if (this.config.hasPermissions?.(permissionEntries)) {
      return true;
    }

    const manifest = this.config.getManifest();
    if (manifest === undefined) {
      return false;
    }

    const manifests = Array.isArray(manifest) ? manifest : [manifest];
    const requestedEntries = expandPermissionEntries(permissionEntries);
    return requestedEntries.every((entry) =>
      manifests.some((candidate) => {
        const resolved = resolveManifest(candidate);
        return resolved.resources.some(
          (resource) =>
            resource.service === entry.service &&
            spaceMatches(resource.space, entry.space) &&
            resource.path === entry.path &&
            entry.actions.every((action) => resource.actions.includes(action)),
        );
      }),
    );
  }

}
