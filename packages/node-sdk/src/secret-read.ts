/**
 * Secret reads, loaded on the first `readSecret` or `DelegatedAccess.encryption`
 * use: the projection of a vault read onto {@link SecretReadResult}, and the
 * encryption and vault services of a {@link DelegatedAccess}.
 */
import type { KVService, ServiceContext } from "@tinycloud/sdk-core";
import type { EncryptionService, parsePermissionHint, VaultNetworkReadResult } from "@tinycloud/sdk-services";
import type { DelegatedEncryptionFactory } from "./DelegatedAccess";
import type { SecretReadResult } from "./TinyCloudNode";

/** A {@link DelegatedAccess}'s decrypt service and its secret read, both signing with the access's session. */
export interface DelegatedSecrets {
  encryption: EncryptionService;
  read(vaultKey: string): Promise<SecretReadResult>;
}

/**
 * Build the access's encryption (registered on its context) and the vault behind its secret reads. `kv` is a
 * fresh, unprefixed KV service from the root: vault records sit at full space keys, outside the delegation's prefix.
 */
export function delegatedSecrets(
  context: ServiceContext,
  factory: DelegatedEncryptionFactory | undefined,
  kv: KVService,
  parseHint: typeof parsePermissionHint,
): DelegatedSecrets {
  if (!factory) {
    throw new Error("This delegated access was created without encryption.");
  }
  const encryption = factory.encryption();
  encryption.initialize(context);
  context.registerService("encryption", encryption);
  kv.initialize(context);
  const vault = factory.vault(kv, encryption);
  vault.initialize(context);
  return {
    encryption,
    read: async (vaultKey) => secretReadResult(await vault.readNetworkEncrypted<unknown>(vaultKey), parseHint),
  };
}

function isSecretPayload(
  value: unknown,
): value is { value: string; createdAt: string; updatedAt: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    typeof value.value === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string"
  );
}

/**
 * Project a network-encrypted vault read of a secret record onto the safe
 * {@link SecretReadResult}: no node response, envelope or key material.
 * `parseHint` is the root's `parsePermissionHint`, so this file carries no copy of sdk-services.
 */
export function secretReadResult(
  result: VaultNetworkReadResult<unknown>,
  parseHint: typeof parsePermissionHint,
): SecretReadResult {
  if (result.status !== "ok") {
    if (result.status === "permission_required") {
      const hint = parseHint(result.hint);
      if (hint === undefined) return { status: "read_failed" };
      return {
        status: "permission_required",
        hint: {
          service: hint.service,
          ...(hint.space === undefined ? {} : { space: hint.space }),
          path: hint.path,
          actions: [...hint.actions],
        },
      };
    }
    // `aad_mismatch` needs `expectAad`, which a secret read never sets.
    if (result.status === "aad_mismatch") return { status: "read_failed" };
    return { status: result.status };
  }
  if (!isSecretPayload(result.entry.value)) {
    return { status: "invalid_payload" };
  }
  return { status: "ok", value: result.entry.value.value };
}
