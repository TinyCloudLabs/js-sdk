---
"@tinycloud/node-sdk": patch
---

Replica erase and purge refuse a symlinked or replaced identity, `replicas/` or replica directory, leaving the purge intent queued, and remove a leftover replica directory without a database only when it holds the store's own files, without recursion.
