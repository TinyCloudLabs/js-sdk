---
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
---

Support delegated SQL table, column and read-only caveats (`tables`, `columns`, `readOnly`) on `tinycloud.sql/*`, for nodes that list `sql-delegated-caveats-v1` in `/info` features.

sdk-core: `parseSqlCaveatList`, `foldSqlName`, `sqlCaveatContains` and `sqlCaveatListsEquivalent` read and compare a SQL caveat list (names fold ASCII-only; a list with a delegated entry has exactly that one entry). Manifest validation checks `tinycloud.sql` caveat lists and refuses non-empty `tinycloud.duckdb` caveats. Capability coverage compares delegated SQL caveats by folded form.

sdk-services: a 403 `sql_caveat_violation: <arm>` maps to `SQL_CAVEAT_VIOLATION` with `meta.arm` (`table`, `column`, `write` or `chain`).

node-sdk: `supportsSqlDelegatedCaveats`; a delegation or grant that carries a delegated SQL caveat is refused with `SqlDelegatedCaveatsUnsupportedError` (`SQL_DELEGATED_CAVEATS_UNSUPPORTED`) and no request when the node does not list the feature or its features are unknown.

Details: TC-1839
