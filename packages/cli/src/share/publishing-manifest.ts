import type { PermissionEntry } from "@tinycloud/node-sdk";

/** `--manifest` reference that resolves to {@link SHARE_PUBLISHING_MANIFEST}. */
export const SHARE_PUBLISHING_MANIFEST_REF = "builtin:share-publishing";

/**
 * Exactly the owner-space authority `tc share` needs, in the app manifest
 * shape `tc auth login --manifest` accepts. One space (`default`), the
 * capability-read entry OpenKey requires, two KV prefixes, no delete:
 *
 * - `tinycloud.capabilities/read` on path `""`: required by OpenKey to sign
 *   any delegation (its consent page shows it as required, not uncheckable);
 *   lets the CLI read its own capability set.
 *
 * - `xyz.tinycloud.share/shares/` (bearer links):
 *   - `put` stores the source file;
 *   - `get` lets the session mint the link's read-only child delegation
 *     (a session can only delegate authority it holds).
 * - `shares/` (addressed `--to email:|did:|domain:`):
 *   - `put` stores the network-encrypted source, and backs `--action edit`;
 *   - `get` + `metadata` back the Policy/v3 root that grants recipients read,
 *     and `get` signs `--notify` delivery authorization;
 *   - `list` backs `--action list` (recipient listing of a `--prefix` share).
 *
 * Not requested:
 * - `del`: no `tc share` command deletes stored sources.
 * - `list` on the bearer prefix: bearer links are single files.
 * - Inspect and receive use the link's own authority, not the owner's.
 * - Revoke signs `tinycloud.delegation/revoke` over the delegation's own CID
 *   and a Policy/v3 root revocation with the session key that issued them;
 *   neither is a space capability.
 */
export const SHARE_PUBLISHING_MANIFEST = {
  app_id: "xyz.tinycloud.share",
  name: "TinyCloud Share publishing",
  space: "default",
  permissions: [
    {
      service: "tinycloud.capabilities",
      path: "",
      skipPrefix: true,
      actions: ["tinycloud.capabilities/read"],
    },
    {
      service: "tinycloud.kv",
      path: "xyz.tinycloud.share/shares/",
      skipPrefix: true,
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    },
    {
      service: "tinycloud.kv",
      path: "shares/",
      skipPrefix: true,
      actions: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/put", "tinycloud.kv/list"],
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
