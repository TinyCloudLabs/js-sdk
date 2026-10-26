import {
  ACCOUNT_REGISTRY_SPACE,
  BOOTSTRAP_SESSION_REQUESTS,
  KV,
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
 * Account space: exactly the rows of the account candidate in
 * `BOOTSTRAP_ALLOWLIST` (`BOOTSTRAP_SESSION_REQUESTS.account`): the registry
 * keys (`applications/`, `spaces/`) and the account index database. Network
 * creation is added as a raw ability by the step.
 */
const ACCOUNT_ROWS: PermissionEntry[] = BOOTSTRAP_SESSION_REQUESTS.account.resources.map((row) => ({
  service: row.service,
  space: row.space,
  path: row.path,
  actions: [...row.actions],
  skipPrefix: true,
}));

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

const ACCOUNT_STEP_REQUEST = stepRequest(ACCOUNT_REGISTRY_SPACE, ACCOUNT_ROWS);

export interface BootstrapSessionRequestOptions {
  /**
   * Key of the completion marker. Pass it only when the sign-in session does
   * not already cover a marker write: the account session then also carries
   * kv get/put on that exact key. Without it the recap stays inside the
   * account candidate of the bootstrap allowlist.
   */
  markerKey?: string;
}

/**
 * The recap a bootstrap session signs for `space`, or `undefined` when no
 * bootstrap step reads or writes that space (so no session is created for it).
 */
export function bootstrapSessionRequest(
  space: BootstrapSpaceName,
  options: BootstrapSessionRequestOptions = {},
): ComposedManifestRequest | undefined {
  if (space === ACCOUNT_REGISTRY_SPACE) {
    if (options.markerKey === undefined) return ACCOUNT_STEP_REQUEST;
    return stepRequest(ACCOUNT_REGISTRY_SPACE, [
      ...ACCOUNT_ROWS,
      {
        service: "tinycloud.kv",
        space: ACCOUNT_REGISTRY_SPACE,
        path: options.markerKey,
        actions: [KV.GET, KV.PUT],
        skipPrefix: true,
      },
    ]);
  }
  if (space === SECRETS_SPACE) return SECRETS_STEP_REQUEST;
  return undefined;
}
