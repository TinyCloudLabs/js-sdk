/**
 * The only SQL-caveat code that every sdk-core consumer carries (including the
 * web bundle): a key-presence test with no grammar, the unsupported-feature
 * error, and the slot the full grammar installs itself into. The grammar,
 * folding and containment live in `@tinycloud/sdk-core/sql-caveats`.
 */

/** Name of the node `/info` feature that enables the delegated SQL caveat form. */
export const SQL_DELEGATED_CAVEATS_FEATURE = "sql-delegated-caveats-v1";

/**
 * Thrown, with no request made, when a delegation or grant carries a
 * delegated SQL caveat (`tables`, `columns`, `readOnly`) and the target node
 * has not announced the `sql-delegated-caveats-v1` feature (or the SDK does
 * not know what the node supports).
 */
export class SqlDelegatedCaveatsUnsupportedError extends Error {
  readonly code = "SQL_DELEGATED_CAVEATS_UNSUPPORTED" as const;

  constructor(readonly host?: string) {
    super("This node cannot limit SQL grants by table or column, so nothing was sent.");
    this.name = "SqlDelegatedCaveatsUnsupportedError";
  }
}

/**
 * Whether sending this caveat list needs the node's `sql-delegated-caveats-v1`
 * feature. A node without it refuses everything but a lone constrained-
 * statements profile, an absent list, and `[{}]` (which the wire collapses to
 * no caveats), so this is true when:
 * - some entry is not a plain object (a `Map`, a class instance, an array, a
 *   primitive): its keys cannot be read, so it fails closed;
 * - some entry is non-empty with neither `mode` nor `constrained-statements`
 *   (the delegated form, valid or not);
 * - there are two or more entries, all empty (`[{}, {}]`).
 *
 * `[]`, `[{}]` and profile lists are false. Meant for gates, so it does not
 * require the list to be valid.
 */
export function sqlCaveatListNeedsDelegatedFeature(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  let empty = 0;
  for (const entry of list as unknown[]) {
    const prototype = entry === null || typeof entry !== "object" ? undefined : Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) return true;
    const keys = Object.keys(entry as object);
    if (keys.length === 0) empty++;
    else if (!keys.includes("mode") && !keys.includes("constrained-statements")) return true;
  }
  return empty > 1 && empty === list.length;
}

/**
 * The full grammar, installed by importing `@tinycloud/sdk-core/sql-caveats`.
 * Without it (the web bundle) a delegated SQL caveat is refused, never accepted
 * unparsed. Each check returns the refusal text, or `undefined` when valid.
 */
export interface SqlCaveatExtension {
  /** A manifest permission's caveat list for `tinycloud.sql` or `tinycloud.duckdb`. */
  checkManifest(service: string, list: readonly Record<string, unknown>[]): string | undefined;
  checkEntry(entry: Readonly<Record<string, unknown>>): string | undefined;
  listsEquivalent(left: unknown, right: unknown): boolean;
  entryContains(parent: Readonly<Record<string, unknown>>, child: Readonly<Record<string, unknown>>): boolean;
}

// One slot per realm, not per module copy: each sdk-core entry point is built with its own copy of this file.
const SLOT: unique symbol = Symbol.for("@tinycloud/sdk-core/sql-caveat-extension");
// A symbol-keyed property on the global object has no declared shape; this names the one property read and written.
const realm = globalThis as { [SLOT]?: SqlCaveatExtension };

/** The installed grammar, if `@tinycloud/sdk-core/sql-caveats` was imported. */
export const sqlCaveatExtension = (): SqlCaveatExtension | undefined => realm[SLOT];

/** Used by `@tinycloud/sdk-core/sql-caveats` when it is imported. */
export function installSqlCaveatExtension(extension: SqlCaveatExtension): void {
  realm[SLOT] = extension;
}
