---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/sdk-services": patch
---

Fix runtime permission selection so the primary session's own recap always
out-ranks any other covering runtime grant (TC-111).

Previously `selectInvocationSession`/`invokeAnyWithRuntimePermissions` picked the
first covering grant in insertion order, so a broad — possibly broken —
bootstrap or delegated grant could hijack an operation the primary session
itself already authorized and 401. The primary session is now registered as a
synthetic highest-trust (`provenance: "primary"`) runtime grant built from the
raw SIWE recap (full owner-scoped space URIs, so owners can never be conflated),
and grant selection filters covering grants then prefers the primary. Spaces the
node skipped activating this sign-in are excluded from the synthetic grant so it
can never out-rank a working grant. The synthetic primary grant is never exposed
through `getRuntimePermissionDelegations`/`hasRuntimePermissions`.
