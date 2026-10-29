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

import { expandRuntimePermissionEntries, type Manifest, type PermissionEntry } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

export interface RequestPermissionsCoreDeps {
  /** Current stored manifest. Must be defined — caller validates first. */
  manifest: Manifest;
  /** Authenticated owner from the current node, never from a requested resource. */
  ownerDid?: string;
  /**
   * Show the permission request modal. Resolves with `{ approved }`
   * once the user interacts. In tests this is a stub; in production it
   * is `ModalManager.showPermissionRequestModal`.
   */
  showModal: (opts: {
    appName: string;
    appIcon?: string;
    additional: PermissionEntry[];
  }) => Promise<{
    approved: boolean;
    suppressPromptFor30Days?: boolean;
  }>;
  /** Whether this page/app has opted out of the SDK explainer prompt. */
  isPromptSuppressed?: () => boolean;
  /** Persist a successful opt-out from the SDK explainer prompt. */
  suppressPromptFor30Days?: () => void;
  /** Store approved permissions as runtime delegations. */
  grantPermissions: (
    additional: PermissionEntry[],
    options?: RequestPermissionsOptions,
  ) => Promise<readonly PortableDelegation[] | void>;
}

export interface RequestPermissionsCoreResult {
  approved: boolean;
  delegations?: readonly PortableDelegation[];
}

export interface RequestPermissionsOptions {
  /** Requested lifetime of the issued delegation, in milliseconds. */
  expiryMs?: number;
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
 * Normalize only encryption key creation here. Other runtime entries retain
 * their existing Web consent representation; the node validates them.
 */
export function normalizeRuntimeKeyCreatePermissions(
  additional: PermissionEntry[],
  ownerDid?: string,
): PermissionEntry[] {
  let normalized = additional;
  for (let index = 0; index < additional.length; index++) {
    const entry = additional[index]!;
    if (entry.service !== "tinycloud.encryption" ||
      !entry.actions.some((action) => action === "key.create" || action === "tinycloud.encryption/key.create")) {
      continue;
    }
    const expanded = expandRuntimePermissionEntries([entry], ownerDid);
    if (normalized === additional) normalized = additional.slice();
    normalized[index] = expanded[0]!;
  }
  return normalized;
}

/**
 * Core escalation flow. See the TinyCloudWeb.requestPermissions JSDoc
 * for the full spec-level description — this function is the plumbing.
 *
 * `options.expiryMs` requests the lifetime of the issued step-up
 * delegation. The node clamps it to the session expiry, so the issued
 * delegation never outlives the session.
 */
export async function requestPermissionsCore(
  additional: PermissionEntry[],
  deps: RequestPermissionsCoreDeps,
  options?: RequestPermissionsOptions,
): Promise<RequestPermissionsCoreResult> {
  validateAdditionalPermissions(additional);
  const expiryMs = options?.expiryMs;
  if (expiryMs !== undefined && !(expiryMs > 0 && Number.isFinite(expiryMs))) {
    throw new Error("requestPermissions expiryMs must be a positive finite number");
  }
  const requested = normalizeRuntimeKeyCreatePermissions(additional, deps.ownerDid);

  let shouldSuppressPrompt = false;
  if (deps.isPromptSuppressed?.() !== true) {
    const modalResult = await deps.showModal({
      appName: deps.manifest.name,
      appIcon: deps.manifest.icon,
      additional: requested,
    });

    if (!modalResult.approved) {
      return { approved: false };
    }

    shouldSuppressPrompt = modalResult.suppressPromptFor30Days === true;
  }

  const delegations =
    options === undefined
      ? await deps.grantPermissions(requested)
      : await deps.grantPermissions(requested, options);

  if (shouldSuppressPrompt) {
    deps.suppressPromptFor30Days?.();
  }

  return Array.isArray(delegations)
    ? { approved: true, delegations }
    : { approved: true };
}
