/*
 * "Does this session hold this ability?" for panel reads. One check, used before a read goes out,
 * so a session that was never granted an ability does not send a request the node will refuse.
 * The answer comes from the session's signed ReCap and installed runtime delegations
 * (`PanelDataHost.hasPermissions`); nothing is sent and nothing prompts.
 */
import type { PermissionEntry } from "@tinycloud/sdk-core";

import type { PanelDataHost } from "../data";

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
