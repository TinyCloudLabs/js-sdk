import { PermissionEntrySchema } from "@tinycloud/operations/artifacts";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { scopeCovers } from "./scoped-login.js";

const CID = /^bafkr4i[a-z2-7]{52}$/;

export interface CoveringGrant {
  readonly cid: string;
  readonly expiry: string;
}

function read(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * The stored, unexpired grants whose recorded scope already holds everything requested, by CID and expiry. `auth request
 * --grant --fresh` lists them beside the new grant so the owner and the agent can see both; nothing here is used as authority
 * and nothing is changed: the old grant is neither removed nor revoked.
 */
export function storedGrantsCovering(
  stored: readonly unknown[],
  requested: readonly PermissionEntry[],
  ownerDid: string | undefined,
  now: number = Date.now(),
): CoveringGrant[] {
  if (ownerDid === undefined) return [];
  const found: CoveringGrant[] = [];
  for (const entry of stored) {
    const delegation = read(entry, "delegation");
    const cid = read(delegation, "cid");
    const expiry = read(delegation, "expiry");
    if (typeof cid !== "string" || !CID.test(cid) || (typeof expiry !== "string" && !(expiry instanceof Date))) continue;
    const expiresAt = new Date(expiry);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now) continue;
    const scope = PermissionEntrySchema.array().safeParse(read(entry, "permissions"));
    if (!scope.success || !scopeCovers(scope.data, requested, ownerDid)) continue;
    if (!found.some((item) => item.cid === cid)) found.push({ cid, expiry: expiresAt.toISOString() });
  }
  return found;
}
