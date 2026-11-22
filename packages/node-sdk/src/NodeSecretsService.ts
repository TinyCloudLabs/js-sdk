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
  type SecretGetOptions,
  type SecretScopeOptions,
  type SecretPutOptions,
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

function secretActionName(
  action: SecretAction,
): "get" | "put" | "del" | "list" {
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

  // A secret opens with decrypt on its own key and is written after
  // key.create on it (TC-3284); never the network root, never a prefix.
  if ((action === "get" || action === "put") && encryptionNetworkId !== undefined) {
    entries.push({
      service: "tinycloud.encryption",
      path: `${encryptionNetworkId}/${resolveSecretPath(name, options).keyPath}`,
      actions: [action === "get" ? "decrypt" : "key.create"],
      skipPrefix: true,
    });
  }

  return entries;
}

function normalizeSpace(
  space: string | undefined,
  resolveSpace?: (space: string) => string,
): string | undefined {
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
  return (
    normalizeSpace(granted, resolveSpace) ===
    normalizeSpace(requested, resolveSpace)
  );
}

export interface NodeSecretsServiceConfig {
  getService: () => ISecretsService;
  space?: string;
  getManifest: () => Manifest | Manifest[] | undefined;
  hasPermissions?: (permissions: PermissionEntry[]) => boolean;
  grantPermissions: (additional: PermissionEntry[]) => Promise<unknown>;
  canEscalate: () => boolean;
  /**
   * Returns the entries that neither the session nor a live runtime grant
   * covers. When absent, every requested entry is escalated.
   */
  uncoveredEntries?: (permissions: PermissionEntry[]) => PermissionEntry[];
  getEncryptionNetworkId?: () => string;
  resolveSpace?: (space: string) => string;
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

  /**
   * Never asks for authority unless `options.requestPermission`: a read with
   * no live grant for the secret's own key is `DECRYPT_DENIED`, without a
   * wallet prompt, so a background read cannot sign (TC-3801).
   */
  async get(
    name: string,
    options?: SecretGetOptions,
  ): ReturnType<ISecretsService["get"]> {
    const permission = await this.ensurePermission(name, options, "get");
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.get(name)
      : this.service.get(name, options);
  }

  async getEntry(
    name: string,
    options?: SecretGetOptions,
  ): ReturnType<ISecretsService["getEntry"]> {
    const permission = await this.ensurePermission(name, options, "get");
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.getEntry(name)
      : this.service.getEntry(name, options);
  }

  async put(
    name: string,
    value: string,
    options?: SecretPutOptions,
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

  async list(
    options?: SecretScopeOptions,
  ): ReturnType<ISecretsService["list"]> {
    const permission = await this.ensurePermission("", options, "list");
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.list()
      : this.service.list(options);
  }

  async listAll(): ReturnType<ISecretsService["listAll"]> {
    const permission = await this.ensurePermission("", undefined, "list");
    if (!permission.ok) return permission;
    return this.service.listAll();
  }

  private get service(): ISecretsService {
    return this.config.getService();
  }

  private async ensurePermission(
    name: string,
    options: SecretGetOptions | undefined,
    action: SecretAction,
  ): Promise<Result<void, ServiceError | VaultError>> {
    // Writes and lists still ask as before; a read asks only when told to.
    const mayAsk = action !== "get" || options?.requestPermission === true;
    const target = name || "secrets";
    let permissionEntries: PermissionEntry[];
    const networkId = action === "get" || action === "put" ? this.config.getEncryptionNetworkId?.() : undefined;
    try {
      permissionEntries = secretPermissionEntries(name, options, action, this.space, networkId);
    } catch (error) {
      return secretsError(
        ErrorCodes.INVALID_INPUT,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error : undefined,
      );
    }
    // A node that cannot sign for the secret's own key still reads a secret
    // sealed to the network before TC-3284 when it opens the whole network;
    // that is accepted, never asked for. Not under `namedKeyOnly`.
    const [kvEntry, keyEntry] = permissionEntries;
    const networkRead = action === "get" && networkId !== undefined && keyEntry !== undefined &&
      keyEntry.path !== networkId && options?.namedKeyOnly !== true &&
      (!mayAsk || !this.config.canEscalate())
      ? [kvEntry!, { ...keyEntry, path: networkId }]
      : undefined;

    if (this.hasPermission(permissionEntries) || (networkRead !== undefined && this.hasPermission(networkRead))) {
      return ok();
    }

    let escalation: PermissionEntry[];
    try {
      escalation =
        this.config.uncoveredEntries?.(permissionEntries) ?? permissionEntries;
      if (escalation.length > 0 && networkRead !== undefined && this.config.uncoveredEntries?.(networkRead).length === 0) {
        escalation = [];
      }
    } catch (error) {
      return this.escalationError(action, target, error);
    }
    // Coverage is decided before the signer gate, so a node that already covers
    // every entry needs no signer. Only when the callback is wired; without it
    // the gate still runs first.
    if (this.config.uncoveredEntries !== undefined && escalation.length === 0) {
      return ok();
    }

    if (!mayAsk) return this.readDenied(name, options, escalation, keyEntry);

    if (!this.config.canEscalate()) {
      return secretsError(
        ErrorCodes.PERMISSION_DENIED,
        `Cannot autosign ${displayActionUrn(action)} for ${target}; TinyCloudNode needs wallet mode with a signer or privateKey.`,
      );
    }

    try {
      await this.config.grantPermissions(escalation);
      return this.restoreUnlockAfterEscalation();
    } catch (error) {
      return this.escalationError(action, target, error);
    }
  }

  /**
   * A read that may not ask: missing decrypt on the secret's own key is
   * `DECRYPT_DENIED` naming that key; a missing KV read stays a plain denial.
   */
  private readDenied(
    name: string,
    options: SecretGetOptions | undefined,
    missing: PermissionEntry[],
    keyEntry: PermissionEntry | undefined,
  ): Result<never, ServiceError | VaultError> {
    if (keyEntry !== undefined && missing.some((entry) => entry.service === "tinycloud.encryption")) {
      return {
        ok: false,
        error: {
          code: "DECRYPT_DENIED",
          service: "vault",
          key: resolveSecretPath(name, options).vaultKey,
          message: `No live grant to decrypt ${name}; ask for permissionHint, or read with requestPermission.`,
          permissionHint: { service: "tinycloud.encryption", path: keyEntry.path, actions: ["tinycloud.encryption/decrypt"] },
        },
      };
    }
    return secretsError(
      ErrorCodes.PERMISSION_DENIED,
      `No live grant to read ${name}; read with requestPermission to ask for it.`,
    );
  }

  private escalationError(
    action: SecretAction,
    target: string,
    error: unknown,
  ): Result<void, ServiceError | VaultError> {
    return secretsError(
      ErrorCodes.PERMISSION_DENIED,
      error instanceof Error
        ? error.message
        : `Autosign escalation for ${displayActionUrn(action)} on ${target} failed.`,
      error instanceof Error ? error : undefined,
    );
  }

  private async restoreUnlockAfterEscalation(): Promise<
    Result<void, ServiceError | VaultError>
  > {
    if (!this.shouldRestoreUnlock) {
      return ok();
    }
    return this.service.unlock(this.unlockSigner);
  }

  private hasPermission(permissionEntries: PermissionEntry[]): boolean {
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
            spaceMatches(
              resource.space,
              entry.space,
              this.config.resolveSpace,
            ) &&
            resource.path === entry.path &&
            entry.actions.every((action) => resource.actions.includes(action)),
        );
      }),
    );
  }
}
