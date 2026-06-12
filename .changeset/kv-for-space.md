---
"@tinycloud/node-sdk": patch
"@tinycloud/cli": patch
---

Add `TinyCloudNode.kvForSpace(spaceId)` and a `--space` option on `tc kv get/list/head`, mirroring the existing `sqlForSpace` / `tc sql --space`. This lets KV reads target a non-primary space — e.g. reading a manifest app's data kept under the owner's `applications` space (such as Listen's transcripts at `applications/kv/<app-id>/transcript/<id>`) when the session already holds a covering delegation.
