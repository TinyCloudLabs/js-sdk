import { parsePermissionHint, type VaultNetworkReadResult } from "@tinycloud/sdk-services";
import type { SecretReadResult } from "./TinyCloudNode";

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
 */
export function secretReadResult(result: VaultNetworkReadResult<unknown>): SecretReadResult {
  if (result.status !== "ok") {
    if (result.status === "permission_required") {
      const hint = parsePermissionHint(result.hint);
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
