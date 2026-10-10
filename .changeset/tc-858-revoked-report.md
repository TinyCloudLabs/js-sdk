---
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
"@tinycloud/sdk-services": patch
---

Replica status reads existing SQLite state without creating or mutating storage, waiting on mutation guards, or recreating purged replicas. Inspection uses immutable reads when WAL sidecars are absent, and explicitly finalizes prepared statements before closing both inspection and ordinary store handles. Status inspection is bounded and cancelled on controller close or purge; in-process grant revocation remains visible after the handle is generation-fenced.
