---
"@tinycloud/node-sdk": patch
---

Make owner sign-in await its best-effort account registry writes before returning. This prevents an immediate KV write from racing those writes against SQLite-backed nodes.
