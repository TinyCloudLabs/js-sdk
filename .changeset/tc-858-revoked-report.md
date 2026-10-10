---
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
"@tinycloud/sdk-services": patch
---

Replica status reads existing SQLite state read-only without creating a replica, identity, device, or blob directories, and never recreates a database that does not exist or was purged. Existing databases use normal read-only WAL mode so committed revocation and reset state is visible; SQLite may create its own WAL or shared-memory sidecars. Missing databases remain untouched, and open/read failures report unavailable rather than healthy. Inspection explicitly finalizes prepared statements before closing both inspection and ordinary store handles. Status inspection is bounded and cancelled on controller close or purge; in-process grant revocation remains visible after the handle is generation-fenced.
