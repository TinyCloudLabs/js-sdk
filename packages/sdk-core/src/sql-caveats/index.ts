/**
 * Delegated SQL caveats (`tables` / `columns` / `readOnly` on `tinycloud.sql/*`),
 * behind the node's `sql-delegated-caveats-v1` feature: the grammar, ASCII-only
 * name folding and per-hop containment.
 *
 * Importing this entry point also turns the grammar on inside sdk-core's
 * manifest validation, policy-capability validation and capability coverage.
 * Bundles that never import it (the web SDK) refuse a delegated SQL caveat
 * instead of parsing it.
 */

import {
  SqlCaveatError,
  delegatedSqlCaveatContains,
  parseDelegatedSqlEntry,
} from "../policy/delegatedCaveats";
import { parseSqlCaveatList, sqlCaveatListsEquivalent } from "../policy/sqlCaveatList";
import { installSqlCaveatExtension } from "../policy/sqlCaveatGate";

export {
  SQL_CAVEAT_MAX_NAME_BYTES,
  SQL_CAVEAT_MAX_NAMES,
  SqlCaveatError,
  delegatedSqlCaveatContains,
  foldSqlName,
  parseDelegatedSqlEntry,
  sqlCaveatContains,
  type DelegatedSqlCaveat,
  type SqlCaveatList,
} from "../policy/delegatedCaveats";
export { parseSqlCaveatList, sqlCaveatListsEquivalent } from "../policy/sqlCaveatList";
export {
  SQL_DELEGATED_CAVEATS_FEATURE,
  SqlDelegatedCaveatsUnsupportedError,
  sqlCaveatListNeedsDelegatedFeature,
} from "../policy/sqlCaveatGate";

/** The refusal text of a caveat check, or `undefined` when `check` accepts. */
function refusalOf(check: () => unknown, withIndex: boolean): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    if (error instanceof SqlCaveatError) return withIndex ? error.message : error.reason;
    throw error;
  }
}

installSqlCaveatExtension({
  checkManifest: (service, list) =>
    service === "tinycloud.duckdb"
      // The node reads only a lone entry (`[]` and `[{}]` are no caveats); two or more entries are refused whatever they hold.
      ? list.length > 1 || list.some((caveat) => Object.keys(caveat).length > 0) ? "are not defined for tinycloud.duckdb" : undefined
      : refusalOf(() => parseSqlCaveatList(list), true),
  // `caveats` absent already says "unrestricted"; an empty object would be a second spelling of it.
  checkEntry: (entry) =>
    Object.keys(entry).length === 0 ? "must not be empty" : refusalOf(() => parseDelegatedSqlEntry(entry), false),
  listsEquivalent: sqlCaveatListsEquivalent,
  entryContains: (parent, child) => delegatedSqlCaveatContains(parseDelegatedSqlEntry(parent), parseDelegatedSqlEntry(child)),
});
