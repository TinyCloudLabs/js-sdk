/**
 * Pure core of the `TinyCloudWeb.requestPermissions` escalation flow.
 *
 * Exposed as a standalone function so unit tests can exercise the
 * control flow (validation → modal → grant) without
 * instantiating the full `TinyCloudWeb` class (which wants a real WASM
 * binding and browser wallet signer).
 *
 * Not re-exported from the package entry point — test surface only.
 *
 * @packageDocumentation
 */

import type { Manifest, PermissionEntry } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

export interface RequestPermissionsCoreDeps {
  /** Current stored manifest. Must be defined — caller validates first. */
  manifest: Manifest;
  /**
   * Show the permission request modal. Resolves with `{ approved }`
   * once the user interacts. In tests this is a stub; in production it
   * is `ModalManager.showPermissionRequestModal`.
   */
  showModal: (opts: {
    appName: string;
    appIcon?: string;
    additional: PermissionEntry[];
  }) => Promise<{ approved: boolean }>;
  /** Store approved permissions as runtime delegations. */
  grantPermissions: (
    additional: PermissionEntry[],
  ) => Promise<readonly PortableDelegation[] | void>;
}

export interface RequestPermissionsCoreResult {
  approved: boolean;
  delegations?: readonly PortableDelegation[];
}

/**
 * Validate the additional permissions array and throw with a clear
 * message if empty. Exported so the caller (`TinyCloudWeb`) can share
 * the same error text.
 */
export function validateAdditionalPermissions(
  additional: PermissionEntry[],
): void {
  if (!Array.isArray(additional) || additional.length === 0) {
    throw new Error(
      "requestPermissions requires a non-empty additional permissions array",
    );
  }
}

/**
 * Core escalation flow. See the TinyCloudWeb.requestPermissions JSDoc
 * for the full spec-level description — this function is the plumbing.
 */
export async function requestPermissionsCore(
  additional: PermissionEntry[],
  deps: RequestPermissionsCoreDeps,
): Promise<RequestPermissionsCoreResult> {
  validateAdditionalPermissions(additional);

  const modalResult = await deps.showModal({
    appName: deps.manifest.name,
    appIcon: deps.manifest.icon,
    additional,
  });

  if (!modalResult.approved) {
    return { approved: false };
  }

  const delegations = await deps.grantPermissions(additional);

  return Array.isArray(delegations)
    ? { approved: true, delegations }
    : { approved: true };
}
