import type { ShareIndexRow } from "./schema.js";

/**
 * Who owns a CID (design C §5 check 7, C2/C3): web > proven > chained >
 * unproven, whatever the arrival order. A later higher claim displaces every
 * admitted lower row it collides with, in the same CAS; a lower or equal
 * claim never displaces anything, and `unproven` never displaces anything.
 *
 * A `migrated` row (one-time owner import) sits at an owner-layout key but
 * ranks by its verified proof state, never as a web row, and a migrated claim
 * never displaces a row whose revocation the node confirmed.
 */
const RANK: Readonly<Record<string, number>> = { unproven: 0, chained: 1, proven: 2, web: 3 };

function isWebRow(row: Pick<ShareIndexRow, "src" | "pv">): boolean {
  return row.src === "web" && row.pv !== "migrated";
}

export function claimRank(row: Pick<ShareIndexRow, "src" | "ps" | "pv">): number {
  if (isWebRow(row)) return RANK.web!;
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
    if (isWebRow(row) && isWebRow(other)) continue;
    if (rank <= claimRank(other) || (row.pv === "migrated" && other.r?.confirmed === true)) return { admit: false, heldBy: otherKey };
    displaced.push(otherKey);
  }
  return { admit: true, displaced };
}
