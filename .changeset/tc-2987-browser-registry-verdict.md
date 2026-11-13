---
"@tinycloud/web-sdk": patch
"@tinycloud/sdk-core": patch
---

Reuse confirmed absence for browser registry reads for up to 60 seconds. Registered routes and all writes refresh registry routing before each operation. Continue uncached when the optional cache cannot load.

Details: TC-2987
