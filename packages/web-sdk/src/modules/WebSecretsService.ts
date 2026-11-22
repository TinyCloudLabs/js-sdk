import {
  ErrorCodes,
  namedKeysPutRefusal,
  secretNameTooLongRefusal,
  resolveSecretPath,
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
} from "@tinycloud/sdk-core";
import type { VaultError } from "@tinycloud/sdk-core";
import type { RequestPermissionsOptions } from "./requestPermissionsCore";

type RequestPermissions = (
  additional: PermissionEntry[],
  options?: RequestPermissionsOptions,
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

/** A secret-key ask lasts 1 h (the node caps it at 7 d and the session's end) and always shows the prompt (TC-3801). */
const SECRET_KEY_ASK: RequestPermissionsOptions = { expiryMs: 60 * 60_000, allowPromptSuppression: false };

/** The did:pkh address in an encryption network URN, the only part compared without case. */
const PKH_ADDRESS = /^(urn:tinycloud:encryption:did:pkh:eip155:\d+:)(0x[0-9a-fA-F]{40})(?=:)/;

function foldAddressCase(path: string): string {
  return path.replace(PKH_ADDRESS, (_match, prefix: string, address: string) => prefix + address.toLowerCase());
}

/**
 * The decrypt entry for this secret's own key, `<networkId>/<keyPath>`, when a
 * read was refused with a hint naming exactly that key (address case aside);
 * undefined for any other failure, path, owner or network.
 */
function missingKeyDecrypt(
  error: unknown,
  name: string,
  options: SecretScopeOptions | undefined,
  networkId: string | undefined,
): PermissionEntry | undefined {
  const { code, permissionHint } = (error ?? {}) as {
    code?: unknown;
    permissionHint?: { service?: unknown; path?: unknown };
  };
  const path = permissionHint?.path;
  if (code !== "DECRYPT_DENIED" || permissionHint?.service !== "tinycloud.encryption" ||
    typeof path !== "string" || networkId === undefined) {
    return undefined;
  }
  // Only a read that resolved its name gets this far, so this cannot throw.
  const expected = `${networkId}/${resolveSecretPath(name, options).keyPath}`;
  if (foldAddressCase(path) !== foldAddressCase(expected)) return undefined;
  return { service: "tinycloud.encryption", path: expected, actions: ["decrypt"], skipPrefix: true };
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

export interface WebSecretsServiceConfig {
  getService: () => ISecretsService;
  space?: string;
  getManifest: () => Manifest | Manifest[] | undefined;
  requestPermissions: RequestPermissions;
  /** The encryption network of this secrets space; an opted-in read asks only for a key on it. */
  getEncryptionNetworkId?: () => string | undefined;
  /** Whether the node has named keys. `put` is refused before any prompt when it does not (`false`) and when it cannot be checked (`undefined`). */
  namedKeysSupported?: () => boolean | undefined | Promise<boolean | undefined>;
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

  /** With `requestPermission: true`, a read missing its own key's decrypt asks for exactly that key once, then reads again. */
  get(
    name: string,
    options?: SecretGetOptions,
  ): ReturnType<ISecretsService["get"]> {
    return this.read(name, options, (n, o) => o === undefined ? this.service.get(n) : this.service.get(n, o));
  }

  /** As {@link get}. */
  getEntry(
    name: string,
    options?: SecretGetOptions,
  ): ReturnType<ISecretsService["getEntry"]> {
    return this.read(name, options, (n, o) => o === undefined ? this.service.getEntry(n) : this.service.getEntry(n, o));
  }

  /**
   * The ask goes through this page's permission prompt, never the node's own
   * escalation, so the node reads without `requestPermission`. A declined or
   * failed ask is PERMISSION_DENIED, as for a put; nothing is remembered, so
   * the next opted-in read asks again.
   */
  private async read<T>(
    name: string,
    options: SecretGetOptions | undefined,
    call: (name: string, options?: SecretGetOptions) => Promise<Result<T, ServiceError | VaultError>>,
  ): Promise<Result<T, ServiceError | VaultError>> {
    if (options?.requestPermission !== true) return call(name, options);
    const { requestPermission: _asked, ...rest } = options;
    const forwarded = Object.keys(rest).length > 0 ? rest : undefined;
    const first = await call(name, forwarded);
    const entry = first.ok ? undefined : missingKeyDecrypt(
      (first as { error?: unknown }).error, name, forwarded, this.config.getEncryptionNetworkId?.());
    if (entry === undefined) return first;
    const asked = await this.ask([entry], "tinycloud.encryption/decrypt", name, SECRET_KEY_ASK);
    if (!asked.ok) return asked as Result<never, ServiceError | VaultError>;
    return call(name, forwarded);
  }

  async put(
    name: string,
    value: string,
    options?: SecretPutOptions,
  ): ReturnType<ISecretsService["put"]> {
    const tooLong = secretNameTooLongRefusal(name);
    if (tooLong) return tooLong;
    const refusal = this.config.namedKeysSupported ? namedKeysPutRefusal(await this.config.namedKeysSupported()) : undefined;
    if (refusal) return refusal;
    const permission = await this.ensureMutationPermission(
      name,
      options,
      "put",
    );
    if (!permission.ok) return permission;
    return options === undefined
      ? this.service.put(name, value)
      : this.service.put(name, value, options);
  }

  async delete(
    name: string,
    options?: SecretScopeOptions,
  ): ReturnType<ISecretsService["delete"]> {
    const permission = await this.ensureMutationPermission(
      name,
      options,
      "del",
    );
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

  listAll(): ReturnType<ISecretsService["listAll"]> {
    return this.service.listAll();
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
      permissionEntries = secretPermissionEntries(
        name,
        options,
        action,
        this.space,
      );
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

    return this.ask(permissionEntries, displayActionUrn(action), name);
  }

  private async ask(
    entries: PermissionEntry[],
    action: string,
    name: string,
    options?: RequestPermissionsOptions,
  ): Promise<Result<void, ServiceError | VaultError>> {
    try {
      const result = options === undefined
        ? await this.config.requestPermissions(entries)
        : await this.config.requestPermissions(entries, options);
      if (!result.approved) {
        return secretsError(
          ErrorCodes.PERMISSION_DENIED,
          `Permission request for ${action} on ${name} was declined.`,
        );
      }
      return this.restoreUnlockAfterEscalation();
    } catch (error) {
      return secretsError(
        ErrorCodes.PERMISSION_DENIED,
        error instanceof Error
          ? error.message
          : `Permission request for ${action} on ${name} failed.`,
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
