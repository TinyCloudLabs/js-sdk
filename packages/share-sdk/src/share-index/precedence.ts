import type { ShareIndexRow } from "./schema.js";

/**
 * Who owns a CID (design C §5 check 7, C2/C3): web > proven > chained >
 * unproven, whatever the arrival order. A later higher claim displaces every
 * admitted lower row it collides with, in the same CAS; a lower or equal
 * claim never displaces anything, and `unproven` never displaces anything.
 */
const RANK: Readonly<Record<string, number>> = { unproven: 0, chained: 1, proven: 2, web: 3 };

export function claimRank(row: Pick<ShareIndexRow, "src" | "ps">): number {
  if (row.src === "web") return RANK.web!;
  return RANK[row.ps ?? "unproven"] ?? 0;
}

export type ClaimDecision =
  | { readonly admit: true; readonly displaced: readonly string[] }
  | { readonly admit: false; readonly heldBy: string };

/**
 * Decide a new claim `row` at `key` against the rows already in `rows`.
 * Collisions are rows (other than `key` itself) that claim any CID in common.
 * Web rows never displace other web rows (both are owner-written).
 */
export function decideClaim(rows: Readonly<Record<string, ShareIndexRow>>, key: string, row: ShareIndexRow): ClaimDecision {
  const claims = row.cc ?? [];
  if (claims.length === 0) return { admit: true, displaced: [] };
  const rank = claimRank(row);
  const displaced: string[] = [];
  for (const [otherKey, other] of Object.entries(rows)) {
    if (otherKey === key || other.cc === undefined || !other.cc.some((cid) => claims.includes(cid))) continue;
    const otherRank = claimRank(other);
    if (row.src === "web" && other.src === "web") continue;
    if (rank <= otherRank) return { admit: false, heldBy: otherKey };
    displaced.push(otherKey);
  }
  return { admit: true, displaced };
}
