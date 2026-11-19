/*
 * "Does this session hold this ability?" for panel reads. One check, used before a read goes out,
 * so a session that was never granted an ability does not send a request the node will refuse.
 * The answer comes from the session's signed ReCap and installed runtime delegations
 * (`PanelDataHost.hasPermissions`); nothing is sent and nothing prompts.
 */
import type { PermissionEntry } from "@tinycloud/sdk-core";

import type { PanelDataHost, PermissionAbility } from "../data";

/** The account index read: `tinycloud.sql/read` on the `account` database of the account space. */
export const ACCOUNT_INDEX_READ: PermissionEntry = {
  service: "tinycloud.sql",
  space: "account",
  path: "account",
  actions: ["tinycloud.sql/read"],
};

/** `tinycloud.space/info` on one space, given by its full space id: the storage status read. */
export function spaceInfoOn(spaceId: string): PermissionEntry {
  return { service: "tinycloud.space", space: spaceId, path: "", actions: ["tinycloud.space/info"] };
}

/**
 * True when the session holds `entry`. A host that cannot tell (`hasPermissions` absent) answers true,
 * so its reads are sent as before.
 */
export function sessionHolds(host: Pick<PanelDataHost, "hasPermissions">, entry: PermissionEntry): boolean {
  return host.hasPermissions === undefined || host.hasPermissions([entry]);
}

/**
 * The one read-only entry a tab asks for when its no-access state shows a button, keyed by the ability that state
 * names. Delegations: `delegation/list` on this app's own space (`applications`), never the account space.
 * A tab with no entry here has no button.
 */
export const TAB_PERMISSION: Readonly<Partial<Record<PermissionAbility, PermissionEntry>>> = {
  "delegation/list": { service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] },
};

/** Requested lifetime of a panel-requested grant: 7 days. The SDK shortens it to the session's own expiry. */
export const TAB_PERMISSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The spaces to sign the delegation query for, in the order the SDK tries them (account space, then the
 * session's own space), limited to those the session holds `delegation/list` on. Empty: nothing to send.
 * `undefined`: the host cannot tell, so the SDK picks its own spaces.
 */
export function delegationQuerySpaces(
  host: Pick<PanelDataHost, "hasPermissions" | "accountSpaceId" | "spaceId">,
): readonly string[] | undefined {
  if (host.hasPermissions === undefined) return undefined;
  const spaces: string[] = [];
  for (const spaceId of [host.accountSpaceId, host.spaceId]) {
    if (spaceId === undefined || spaces.includes(spaceId)) continue;
    const list: PermissionEntry = { service: "tinycloud.delegation", space: spaceId, path: "", actions: ["tinycloud.delegation/list"] };
    if (sessionHolds(host, list)) spaces.push(spaceId);
  }
  return spaces;
}
