import {
  ErrorCodes,
  resolveManifest,
  type IDataVaultService,
  type ISecretsService,
  type Manifest,
  type PermissionEntry,
  type Result,
  type ServiceError,
} from "@tinycloud/sdk-core";
import type { VaultError } from "@tinycloud/sdk-core";

type RequestPermissions = (
  additional: PermissionEntry[],
) => Promise<{ approved: boolean; delegations?: readonly unknown[] }>;

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SECRET_PREFIX = "secrets/";
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

function actionUrn(action: "put" | "del"): string {
  return `tinycloud.kv/${action}`;
}

function secretResourcePath(base: "keys" | "vault", name: string): string {
  return `${base}/${SECRET_PREFIX}${name}`;
}

function secretPermissionEntries(
  name: string,
  action: "put" | "del",
): PermissionEntry[] {
  return [
    {
      service: "tinycloud.kv",
      space: SECRETS_SPACE,
      path: secretResourcePath("keys", name),
      actions: [action],
      skipPrefix: true,
    },
    {
      service: "tinycloud.kv",
      space: SECRETS_SPACE,
      path: secretResourcePath("vault", name),
      actions: [action],
      skipPrefix: true,
    },
  ];
}

function isSecretsSpace(space: string): boolean {
  return space === SECRETS_SPACE || space.endsWith(`:${SECRETS_SPACE}`);
}

export interface WebSecretsServiceConfig {
  getService: () => ISecretsService;
  getManifest: () => Manifest | Manifest[] | undefined;
  requestPermissions: RequestPermissions;
  getUnlockSigner?: () => unknown;
}

export class WebSecretsService implements ISecretsService {
  private unlockSigner?: unknown;
  private shouldRestoreUnlock = false;

  constructor(private readonly config: WebSecretsServiceConfig) {}

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

  get(name: string): ReturnType<ISecretsService["get"]> {
    return this.service.get(name);
  }

  async put(name: string, value: string): ReturnType<ISecretsService["put"]> {
    const permission = await this.ensureMutationPermission(name, "put");
    if (!permission.ok) return permission;
    return this.service.put(name, value);
  }

  async delete(name: string): ReturnType<ISecretsService["delete"]> {
    const permission = await this.ensureMutationPermission(name, "del");
    if (!permission.ok) return permission;
    return this.service.delete(name);
  }

  list(): ReturnType<ISecretsService["list"]> {
    return this.service.list();
  }

  private get service(): ISecretsService {
    return this.config.getService();
  }

  private async ensureMutationPermission(
    name: string,
    action: "put" | "del",
  ): Promise<Result<void, ServiceError | VaultError>> {
    if (!SECRET_NAME_RE.test(name)) {
      return secretsError(
        ErrorCodes.INVALID_INPUT,
        `Invalid secret name ${JSON.stringify(name)}. Secret names must match ${SECRET_NAME_RE.source}.`,
      );
    }

    if (this.hasMutationPermission(name, action)) {
      return ok();
    }

    try {
      const result = await this.config.requestPermissions(
        secretPermissionEntries(name, action),
      );
      if (!result.approved) {
        return secretsError(
          ErrorCodes.PERMISSION_DENIED,
          `Permission request for ${actionUrn(action)} on ${name} was declined.`,
        );
      }
      return this.restoreUnlockAfterEscalation();
    } catch (error) {
      return secretsError(
        ErrorCodes.PERMISSION_DENIED,
        error instanceof Error
          ? error.message
          : `Permission request for ${actionUrn(action)} on ${name} failed.`,
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

  private hasMutationPermission(name: string, action: "put" | "del"): boolean {
    const manifest = this.config.getManifest();
    if (manifest === undefined) {
      return false;
    }

    const manifests = Array.isArray(manifest) ? manifest : [manifest];
    const requiredAction = actionUrn(action);
    return manifests.some((entry) => {
      const resolved = resolveManifest(entry);
      return (["keys", "vault"] as const).every((base) =>
        resolved.resources.some(
          (resource) =>
            resource.service === "tinycloud.kv" &&
            isSecretsSpace(resource.space) &&
            resource.path === secretResourcePath(base, name) &&
            resource.actions.includes(requiredAction),
        ),
      );
    });
  }
}
