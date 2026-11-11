import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

const KEY_ACTIONS = ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"];
const SKEW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

function refuse(message: string): never {
  throw new CLIError("APPROVAL_RESULT_INVALID", message, ExitCode.PERMISSION_DENIED);
}

/**
 * The signed result of one invitation approval: exactly one `key.create` + `decrypt` pair on one canonical
 * `<owner default network>/share/<32 lowercase hex>` key, nothing else, expiring within the acceptance window (at most
 * 24 hours). Returns the key id, which only the signed grant may supply.
 */
export function invitationKeyFromGrant(
  permissions: readonly PermissionEntry[],
  input: { ownerDid: string; expiresAt: string; acceptanceExpiresAt: string; now?: number },
): string {
  const now = input.now ?? Date.now();
  const prefix = `urn:tinycloud:encryption:${input.ownerDid}:default/share/`;
  const ids = new Set<string>();
  const actions = new Set<string>();
  for (const entry of permissions) {
    // The space an encryption entry is reported under names no further resource: the path pins the key and its owner.
    const id = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : "";
    if (entry.service !== "tinycloud.encryption" || !/^[a-f0-9]{32}$/.test(id) || (entry.caveats?.length ?? 0) > 0 ||
      !entry.actions.every((action) => KEY_ACTIONS.includes(action))) {
      refuse("The approval holds more than one invitation key and nothing else; no invitation was sent.");
    }
    ids.add(id);
    for (const action of entry.actions) actions.add(action);
  }
  if (ids.size !== 1 || !KEY_ACTIONS.every((action) => actions.has(action))) {
    refuse("The approval does not hold key.create and decrypt on exactly one invitation key; no invitation was sent.");
  }
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) refuse("The invitation approval has expired; no invitation was sent.");
  if (expiry - now > DAY_MS + SKEW_MS || expiry > Date.parse(input.acceptanceExpiresAt) + SKEW_MS) {
    refuse("The approval lasts longer than the invitation it was requested for; no invitation was sent.");
  }
  return [...ids][0]!;
}
