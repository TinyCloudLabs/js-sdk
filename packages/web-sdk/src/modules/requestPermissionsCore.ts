/**
 * Pure core of the `TinyCloudWeb.requestPermissions` escalation flow.
 *
 * Exposed as a standalone function so unit tests can exercise the
 * control flow (validation → modal → compose → signOut → signIn) without
 * instantiating the full `TinyCloudWeb` class (which wants a real WASM
 * binding and browser wallet signer).
 *
 * Not re-exported from the package entry point — test surface only.
 *
 * @packageDocumentation
 */

import type {
  ClientSession,
  Manifest,
  PermissionEntry,
} from "@tinycloud/sdk-core";

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
  /**
   * Tear down the SDK-side session state. Wallet stays connected.
   */
  signOut: () => Promise<void>;
  /**
   * Run a fresh sign-in with the composed manifest already stored on
   * the caller. Returns the new client session on success.
   */
  signIn: () => Promise<ClientSession>;
  /**
   * Write-through hook so the caller can update its stored manifest
   * before the new sign-in runs. Called once, with the composed manifest,
   * only on the approve path.
   */
  writeManifest: (next: Manifest) => void;
}

export interface RequestPermissionsCoreResult {
  approved: boolean;
  session?: ClientSession;
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

  // Union existing permissions with the newly-approved entries. We don't
  // deduplicate — downstream `resolveManifest` merges entries
  // deterministically and the server builds a single recap from the
  // resolved list.
  const composedManifest: Manifest = {
    ...deps.manifest,
    permissions: [...(deps.manifest.permissions ?? []), ...additional],
  };
  deps.writeManifest(composedManifest);

  await deps.signOut();
  const session = await deps.signIn();

  return { approved: true, session };
}
