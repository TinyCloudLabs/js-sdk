---
"@tinycloud/share-envelope": patch
---

`require("@tinycloud/share-envelope/links")` now loads from CommonJS. `dist/links.cjs` bundles `multiformats`, whose subpath exports have no `require` condition, as `dist/index.cjs` already does; the ESM build is unchanged. This also fixes `require("@tinycloud/share-sdk/share-index")`, which requires it.

Details: TC-1739
