import { foldSqlName, parseSqlCaveatList, type SqlCaveatList } from "@tinycloud/sdk-core";

/** JSON with object keys sorted, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry)
    ? entry.map(canonical)
    : entry && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([name, inner]) => [name, canonical(inner)]))
      : entry;
  return JSON.stringify(canonical(value) ?? null);
}

/**
 * The restriction a permission's ReCap caveats impose: "" when unrestricted
 * (no caveats, or only empty ones), else their canonical, order-independent JSON.
 * A delegated SQL caveat (`tables`, `columns`, `readOnly`) is compared by its
 * folded form, so `NOTES` and `Notes` are one table and `readOnly: false` is
 * no restriction; every other caveat is compared exactly.
 */
export function caveatRestriction(caveats: readonly Record<string, unknown>[] | undefined, service?: string): string {
  if (service === "tinycloud.sql") {
    const delegated = delegatedSqlRestriction(caveats);
    if (delegated !== undefined) return delegated;
  }
  const restrictions = (caveats ?? []).filter((caveat) => Object.keys(caveat).length > 0).map(canonicalJson).sort();
  return restrictions.length === 0 ? "" : JSON.stringify(restrictions);
}

/** The folded restriction of a valid delegated SQL caveat list, or undefined for any other list. */
function delegatedSqlRestriction(caveats: readonly Record<string, unknown>[] | undefined): string | undefined {
  let parsed: SqlCaveatList;
  try {
    parsed = parseSqlCaveatList(caveats ?? []);
  } catch {
    return undefined;
  }
  if (parsed.kind !== "delegated") return undefined;
  const { tables, columns, readOnly } = parsed.caveat;
  if (tables === undefined && columns === undefined && !readOnly) return "";
  const folded = (names: readonly string[]): string[] => [...new Set(names.map(foldSqlName))].sort();
  return JSON.stringify([canonicalJson({
    ...(tables === undefined ? {} : { tables: folded(tables) }),
    ...(columns === undefined ? {} : { columns: folded(columns) }),
    ...(readOnly ? { readOnly: true } : {}),
  })]);
}
