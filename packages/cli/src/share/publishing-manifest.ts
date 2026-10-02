import type { PermissionEntry } from "@tinycloud/node-sdk";

/** `--manifest` reference that resolves to {@link SHARE_PUBLISHING_MANIFEST}. */
export const SHARE_PUBLISHING_MANIFEST_REF = "builtin:share-publishing";

/**
 * Exactly the owner-space authority `tc share publish` needs, in the app
 * manifest shape `tc auth login --manifest` already accepts. One space
 * (`default`), two KV prefixes, nothing else:
 *
 * - `xyz.tinycloud.share/shares/` (bearer links): `put` stores the source;
 *   `get` lets the session mint the link's read-only child delegation, which
 *   it can only do for authority it holds itself.
 * - `shares/` (addressed `--to email:|did:|domain:`): `put` stores the
 *   network-encrypted source; `get` + `metadata` back the Policy/v3 root that
 *   grants recipients exactly those two actions.
 * - `list` + `del` on both prefixes let the owner inventory and remove
 *   published sources.
 */
export const SHARE_PUBLISHING_MANIFEST = {
  app_id: "xyz.tinycloud.share",
  name: "TinyCloud Share publishing",
  space: "default",
  permissions: [
    {
      service: "tinycloud.kv",
      path: "xyz.tinycloud.share/shares/",
      skipPrefix: true,
      actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list", "tinycloud.kv/del"],
    },
    {
      service: "tinycloud.kv",
      path: "shares/",
      skipPrefix: true,
      actions: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/put", "tinycloud.kv/list", "tinycloud.kv/del"],
    },
  ],
} as const;

/** The manifest as logical-space permission entries (no profile lookup required). */
export function sharePublishingPermissions(): PermissionEntry[] {
  return SHARE_PUBLISHING_MANIFEST.permissions.map((permission) => ({
    service: permission.service,
    space: SHARE_PUBLISHING_MANIFEST.space,
    path: permission.path,
    actions: [...permission.actions],
  }));
}
