import type { PermissionEntry } from "@tinycloud/node-sdk";

/** `--manifest` reference that resolves to {@link SHARE_PUBLISHING_MANIFEST}. */
export const SHARE_PUBLISHING_MANIFEST_REF = "builtin:share-publishing";

/**
 * Exactly the owner-space authority `tc share` needs, in the app manifest
 * shape `tc auth login --manifest` accepts. One space (`default`), the
 * capability-read entry OpenKey requires, three KV prefixes, no delete:
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
 * - `artifacts/` (`--artifact`, TC-1428):
 *   - `put` writes write-once `artifacts/<aid>/versions/<n>/` files (`If-None-Match: *`) and their manifest;
 *   - `get` mints the pinned share's read-only child delegation and reads back a version on a 412;
 *   - `metadata` backs the Policy/v3 root for addressed artifact shares;
 *   - `list` finds the next version number and backs `share versions`.
 *   Profiles signed in before this entry need `auth login --device --manifest builtin:share-publishing` again.
 *
 * - `tinycloud.encryption/decrypt` on the account's own `default/share/` prefix:
 *   an email-addressed share's policy ceiling includes decrypt on one leaf in that prefix, and without it
 *   `tc share publish --to email:...` is refused (`decrypt-not-held`). A paste sign-in requests it;
 *   OpenKey's device sign-in refuses encryption grants, so `--device` and `enable share` leave it out.
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
    {
      service: "tinycloud.kv",
      path: "artifacts/",
      skipPrefix: true,
      actions: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/put", "tinycloud.kv/list"],
    },
    {
      service: "tinycloud.encryption",
      path: "share/",
      skipPrefix: true,
      actions: ["tinycloud.encryption/decrypt"],
    },
  ],
} as const;

/** The manifest as logical-space permission entries (no profile lookup required), without the decrypt entry: the scope an OpenKey device sign-in can carry. */
export function sharePublishingPermissions(): PermissionEntry[] {
  return SHARE_PUBLISHING_MANIFEST.permissions.filter((permission) => permission.service !== "tinycloud.encryption").map((permission) => ({
    service: permission.service,
    space: SHARE_PUBLISHING_MANIFEST.space,
    path: permission.path,
    actions: [...permission.actions],
  }));
}
