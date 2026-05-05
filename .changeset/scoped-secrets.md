---
"@tinycloud/sdk-core": minor
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.
