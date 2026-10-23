/**
 * Delegated SQL caveats: the `tables` / `columns` / `readOnly` form of a
 * `tinycloud.sql/*` ability caveat, behind the node's
 * `sql-delegated-caveats-v1` feature.
 *
 * This module is pure (no imports). It holds the grammar of one delegated
 * entry, the name folding, and per-hop containment. Reading a whole caveat
 * list (entries, profiles, the one-entry rule) is `parseSqlCaveatList` in
 * `./sqlCaveatList`.
 *
 * Messages built here never repeat a name or any other caveat content: they
 * say which entry (by index) and what kind of problem.
 */

/** Most elements in one `tables` or `columns` list. */
export const SQL_CAVEAT_MAX_NAMES = 256;
/** Longest element of a `tables` or `columns` list, in UTF-8 bytes. */
export const SQL_CAVEAT_MAX_NAME_BYTES = 128;

const DELEGATED_KEYS: readonly string[] = ["tables", "columns", "readOnly"];
const textEncoder = new TextEncoder();
// Rust `char::is_control` is Unicode category Cc; `char::is_whitespace` is the
// Unicode White_Space property. `\s` is not the same set (it adds U+FEFF).
const CONTROL = /\p{Cc}/u;
const EDGE_WHITESPACE = /^\p{White_Space}|\p{White_Space}$/u;

/** A caveat list or entry that cannot be accepted. The message carries no caveat content. */
export class SqlCaveatError extends Error {
  readonly code = "sql-caveat-invalid" as const;

  constructor(
    readonly reason: string,
    readonly index?: number,
  ) {
    super(index === undefined ? `caveats ${reason}` : `caveat ${index} ${reason}`);
    this.name = "SqlCaveatError";
  }
}

/** One delegated-form entry. Names are as written; fold them to compare. */
export interface DelegatedSqlCaveat {
  readonly tables?: readonly string[];
  readonly columns?: readonly string[];
  /** `false` and absent are the same. */
  readonly readOnly: boolean;
}

/** What one `tinycloud.sql/*` ability's caveat list says. */
export type SqlCaveatList =
  /** `[]`, or only empty entries. */
  | { readonly kind: "unrestricted" }
  /** One or more constrained-statements profiles (compared by the profile rules, not here). */
  | { readonly kind: "profile" }
  /** One delegated-form entry. */
  | { readonly kind: "delegated"; readonly caveat: DelegatedSqlCaveat };

/**
 * The comparison form of a table or column name: ASCII letters only.
 * `String.prototype.toLowerCase` would also fold U+212A (KELVIN SIGN) to `k`,
 * which the node keeps distinct. Use this for comparison, never for what is sent.
 */
export function foldSqlName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// A lone surrogate is not text: UTF-8 encoding would silently turn it into U+FFFD.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function nameRefusal(value: unknown): string | undefined {
  if (typeof value !== "string") return "has an element that is not a string";
  if (value.length === 0) return "has an empty element";
  if (LONE_SURROGATE.test(value)) return "has an element that is not well-formed text";
  if (textEncoder.encode(value).length > SQL_CAVEAT_MAX_NAME_BYTES) return "has an element that is too long";
  if (value.includes(".")) return "has an element with a dot";
  if (CONTROL.test(value)) return "has an element with a control character";
  if (EDGE_WHITESPACE.test(value)) return "has an element with leading or trailing whitespace";
  return undefined;
}

function names(value: unknown, index: number | undefined): readonly string[] {
  if (!Array.isArray(value)) throw new SqlCaveatError("has a name list that is not an array", index);
  if (value.length > SQL_CAVEAT_MAX_NAMES) throw new SqlCaveatError("has a name list with too many elements", index);
  const output: string[] = [];
  for (let position = 0; position < value.length; position++) {
    const element: unknown = value[position];
    const refusal = nameRefusal(element);
    if (refusal !== undefined) throw new SqlCaveatError(refusal, index);
    output.push(element as string);
  }
  return output;
}

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Reads one delegated-form entry (an entry without `mode`): keys are a subset
 * of `tables`, `columns`, `readOnly`.
 *
 * @throws {SqlCaveatError}
 */
export function parseDelegatedSqlEntry(
  entry: Readonly<Record<string, unknown>>,
  index?: number,
): DelegatedSqlCaveat {
  if (Object.keys(entry).some((key) => !DELEGATED_KEYS.includes(key))) {
    throw new SqlCaveatError("has an unsupported key", index);
  }
  let readOnly = false;
  if (hasOwn(entry, "readOnly")) {
    if (typeof entry.readOnly !== "boolean") throw new SqlCaveatError("has a readOnly that is not a boolean", index);
    readOnly = entry.readOnly;
  }
  const tables = hasOwn(entry, "tables") ? names(entry.tables, index) : undefined;
  const columns = hasOwn(entry, "columns") ? names(entry.columns, index) : undefined;
  return {
    ...(tables === undefined ? {} : { tables }),
    ...(columns === undefined ? {} : { columns }),
    readOnly,
  };
}

function isNameSubset(parent: readonly string[] | undefined, child: readonly string[] | undefined): boolean {
  if (parent === undefined) return true;
  if (child === undefined) return false;
  const allowed = new Set(parent.map(foldSqlName));
  return child.every((name) => allowed.has(foldSqlName(name)));
}

/**
 * Whether `child` is at least as narrow as `parent` on every axis: its
 * `tables` and `columns` are subsets of the parent's (folded; an absent
 * parent axis allows anything; a child that drops a restricted axis is
 * refused), and `readOnly` may be turned on but not off.
 */
export function delegatedSqlCaveatContains(parent: DelegatedSqlCaveat, child: DelegatedSqlCaveat): boolean {
  return isNameSubset(parent.tables, child.tables) &&
    isNameSubset(parent.columns, child.columns) &&
    (!parent.readOnly || child.readOnly);
}

/**
 * Whether a child delegation's caveat list is at least as narrow as the
 * parent grant's, for one hop. An owner-issued root grant is unconstrained:
 * pass `{ kind: "unrestricted" }` as `parent`.
 *
 * Profile lists are compared by the profile rules elsewhere; here a profile
 * parent contains nothing, and a profile child is contained only by a parent
 * that restricts nothing.
 */
export function sqlCaveatContains(parent: SqlCaveatList, child: SqlCaveatList): boolean {
  if (parent.kind === "unrestricted") return true;
  if (parent.kind === "profile") return false;
  const parentRestricts = parent.caveat.tables !== undefined || parent.caveat.columns !== undefined ||
    parent.caveat.readOnly;
  if (!parentRestricts) return true;
  if (child.kind === "profile") return false;
  return delegatedSqlCaveatContains(
    parent.caveat,
    child.kind === "unrestricted" ? { readOnly: false } : child.caveat,
  );
}
