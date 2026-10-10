---
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
"@tinycloud/sdk-services": patch
---

Replica status reads existing SQLite state without creating or mutating storage, waiting on mutation guards, or recreating purged replicas. Status inspection is bounded and cancelled on controller close or purge; in-process grant revocation remains visible after the handle is generation-fenced.
