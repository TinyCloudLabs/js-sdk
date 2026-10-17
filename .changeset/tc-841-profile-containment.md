---
"@tinycloud/cli": minor
"@tinycloud/operations": patch
"@tinycloud/replica": patch
---

Pin profile and replica directories before SQLite opens during reset and sync, and for local report reads and logout cleanup. Reject whole-profile aliases, symlinked replica roots, entries, database files and persisted report descendants, changed SQLite identities, and expired profile descriptors before access. Gate legacy replica reads on pending logout, including aliases and in-flight reads. Resume cleanup of verified empty legacy replica directories after an interrupted purge without deleting unknown files.

`@tinycloud/operations` resolves user-owned symlinked TinyCloud home directories to a pinned real directory while refusing aliases inside a profile; profile JSON reads verify leaf identity. `@tinycloud/replica` creates SQLite database files exclusively for concurrent openers and checks their identity before migration; on macOS and Windows, replica removal checks each known file and directory before nonrecursive deletion and stops on a changed or unknown entry.

Breaking change (beta feature): `tc replica report` now reads persisted events and identity partitions without starting a replication runtime. `--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`. Use `tc replica reset --replica <name> --purge` only as a partial alternative for named local replicas. Flag-owned purge and pending clearing have no equivalent yet; TC-1309 tracks safe replacement commands.
