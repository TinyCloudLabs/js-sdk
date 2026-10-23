---
"@tinycloud/sdk-services": patch
"@tinycloud/replica": patch
---

The replica workers import only the sdk-services modules they use, so the kv-storage and replica worker bundles no longer include the SQL, DuckDB, vault, and hooks services. Adds a `./context` subpath export to `@tinycloud/sdk-services`.

Details: TC-1827
