---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/cli": minor
---

Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.
