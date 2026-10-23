---
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
---

Support delegated SQL table, column and read-only caveats (`tables`, `columns`, `readOnly`) on `tinycloud.sql/*`, for nodes that list `sql-delegated-caveats-v1` in `/info` features.

sdk-core: new `@tinycloud/sdk-core/sql-caveats` entry point with `parseSqlCaveatList`, `foldSqlName`, `sqlCaveatContains` and `sqlCaveatListsEquivalent`, which read and compare a SQL caveat list (names fold ASCII-only; a list with a delegated entry has exactly that one entry). Importing it also turns the grammar on in manifest validation (`tinycloud.sql` lists; `tinycloud.duckdb` lists with a non-empty or second entry are refused), policy-capability validation and capability coverage (delegated SQL caveats compare by folded form). The package root exports only `SQL_DELEGATED_CAVEATS_FEATURE`, `SqlDelegatedCaveatsUnsupportedError` and `sqlCaveatListNeedsDelegatedFeature`, and bundles that do not import the entry point (the web SDK) refuse a delegated SQL caveat instead of parsing it. `@tinycloud/node-sdk` imports it.

sdk-services: a 403 `sql_caveat_violation` (with or without `: <arm>`) maps to `SqlErrorCodes.SQL_CAVEAT_VIOLATION` (`"SQL_CAVEAT_VIOLATION"`) with `meta.arm` (`table`, `column`, `write` or `chain`). The constant lives in the SQL-only `SqlErrorCodes` export, not in the shared `ErrorCodes`, so bundles that never load the SQL service do not carry it.

node-sdk: `supportsSqlDelegatedCaveats`; a delegation or grant that carries a delegated SQL caveat is refused with `SqlDelegatedCaveatsUnsupportedError` (`SQL_DELEGATED_CAVEATS_UNSUPPORTED`) and no request when the node does not list the feature or its features are unknown.

Details: TC-1839
