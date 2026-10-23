import { validateSqlProfileCaveat, type JsonObject } from "./capability";
import {
  parseDelegatedSqlEntry,
  SqlCaveatError,
  sqlCaveatContains,
  type DelegatedSqlCaveat,
  type SqlCaveatList,
} from "./delegatedCaveats";
import { normalizeJson } from "./jcs";

type CaveatEntry = Readonly<Record<string, unknown>>;

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** Whether `entry` (which has a `mode` key) is a constrained-statements profile this SDK accepts. */
function isProfile(entry: CaveatEntry): boolean {
  try {
    validateSqlProfileCaveat(normalizeJson(entry) as JsonObject);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the caveat list of one `tinycloud.sql/*` ability.
 *
 * Entries of a list are alternatives (ReCap), so:
 * - `[]`, `[{}]`, `[{}, {}]` restrict nothing;
 * - an entry with `mode` is a constrained-statements profile (existing
 *   rules); the nested `{"constrained-statements": ...}` spelling is not
 *   accepted, and `mode` beside `tables` or `columns` is refused;
 * - any other non-empty entry is the delegated form (`tables`, `columns`,
 *   `readOnly` only), and a list with one has exactly that one entry:
 *   a second entry, even `{}`, is refused;
 * - a profile list may not contain an empty entry.
 *
 * @throws {SqlCaveatError} with an index-based message that repeats no caveat content.
 */
export function parseSqlCaveatList(list: unknown): SqlCaveatList {
  if (!Array.isArray(list)) throw new SqlCaveatError("is not a list");
  let delegated: { readonly index: number; readonly caveat: DelegatedSqlCaveat } | undefined;
  let profiles = 0;
  let firstEmpty: number | undefined;
  for (let index = 0; index < list.length; index++) {
    const entry: unknown = list[index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SqlCaveatError("is not an object", index);
    }
    const object = entry as CaveatEntry;
    if (Object.keys(object).length === 0) {
      firstEmpty ??= index;
    } else if (hasOwn(object, "mode")) {
      if (hasOwn(object, "tables") || hasOwn(object, "columns")) {
        throw new SqlCaveatError("mixes a constrained-statements profile with tables or columns", index);
      }
      if (!isProfile(object)) throw new SqlCaveatError("is not a constrained-statements profile", index);
      profiles++;
    } else {
      const caveat = parseDelegatedSqlEntry(object, index);
      delegated ??= { index, caveat };
    }
  }
  if (delegated !== undefined) {
    if (list.length !== 1) throw new SqlCaveatError("is one of several entries", delegated.index);
    return { kind: "delegated", caveat: delegated.caveat };
  }
  if (profiles > 0) {
    if (firstEmpty !== undefined) throw new SqlCaveatError("is not a constrained-statements profile", firstEmpty);
    return { kind: "profile" };
  }
  return { kind: "unrestricted" };
}

/**
 * Whether two caveat lists restrict the same: identical delegated forms up to
 * name folding (`NOTES` and `Notes` are one table, `readOnly: false` is
 * absent). Lists that do not parse, and profile lists, are never equivalent
 * here; callers compare those by exact structure.
 */
export function sqlCaveatListsEquivalent(left: unknown, right: unknown): boolean {
  let first: SqlCaveatList;
  let second: SqlCaveatList;
  try {
    first = parseSqlCaveatList(left);
    second = parseSqlCaveatList(right);
  } catch {
    return false;
  }
  if (first.kind === "profile" || second.kind === "profile") return false;
  return sqlCaveatContains(first, second) && sqlCaveatContains(second, first);
}
