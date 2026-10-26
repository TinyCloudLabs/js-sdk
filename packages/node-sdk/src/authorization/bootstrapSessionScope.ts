import {
  ACCOUNT_MANIFEST_PERMISSIONS,
  ACCOUNT_REGISTRY_SPACE,
  SECRETS_SPACE,
  SQL,
  composeManifestRequest,
  type BootstrapSpaceName,
  type ComposedManifestRequest,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/sdk-core";

/**
 * Lifetime of an account-bootstrap session.
 *
 * Bootstrap signs its sessions up front and uses them within the same
 * `signIn()`: hosting, one activation round trip per session, a few registry
 * writes and the completion marker. That takes seconds; ten minutes leaves
 * room for a slow host or a retried request and no longer. The sessions are
 * held in memory for that window only and are removed when bootstrap ends.
 */
export const BOOTSTRAP_SESSION_EXPIRY_MS = 10 * 60 * 1000;

const ACCOUNT_STEP_SERVICES: Record<string, true> = {
  "tinycloud.kv": true,
  "tinycloud.sql": true,
};

function stepRequest(space: string, permissions: PermissionEntry[]): ComposedManifestRequest {
  const manifest: Manifest = {
    app_id: "xyz.tinycloud.bootstrap",
    name: "TinyCloud Account Bootstrap",
    space,
    prefix: "",
    defaults: false,
    includePublicSpace: false,
    permissions,
  };
  return {
    ...composeManifestRequest([manifest], { includeAccountRegistryPermissions: false }),
    expiryMs: BOOTSTRAP_SESSION_EXPIRY_MS,
  };
}

/**
 * Account space: the registry keys (`applications/`, `spaces/`), the
 * completion marker and the account index database, exactly the rows of
 * {@link ACCOUNT_MANIFEST_PERMISSIONS} that the account steps and the marker
 * read and write. Network creation is added as a raw ability by the step.
 */
const ACCOUNT_STEP_REQUEST = stepRequest(
  ACCOUNT_REGISTRY_SPACE,
  ACCOUNT_MANIFEST_PERMISSIONS.filter((row) => ACCOUNT_STEP_SERVICES[row.service] === true).map(
    (row) => ({
      service: row.service,
      space: row.space,
      path: row.path,
      actions: [...row.actions],
      skipPrefix: true,
    }),
  ),
);

/** Secrets space: the `secret_records` schema migration. */
const SECRETS_STEP_REQUEST = stepRequest(SECRETS_SPACE, [
  {
    service: "tinycloud.sql",
    space: SECRETS_SPACE,
    path: "default",
    actions: [SQL.READ, SQL.WRITE, SQL.SCHEMA],
    skipPrefix: true,
  },
]);

/**
 * The recap a bootstrap session signs for `space`, or `undefined` when no
 * bootstrap step reads or writes that space (so no session is created for it).
 */
export function bootstrapSessionRequest(
  space: BootstrapSpaceName,
): ComposedManifestRequest | undefined {
  if (space === ACCOUNT_REGISTRY_SPACE) return ACCOUNT_STEP_REQUEST;
  if (space === SECRETS_SPACE) return SECRETS_STEP_REQUEST;
  return undefined;
}
