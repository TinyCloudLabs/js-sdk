---
"@tinycloud/sdk-core": minor
---

Preserve typed, bounded HTTP status and diagnostic body on space hosting, public-space, delegation import, and policy runtime failures. Authorization service results change from domain codes such as `NETWORK_ERROR` or `SPACE_CREATION_FAILED` to `AUTH_UNAUTHORIZED` with `meta.status`; thrown errors expose `status`. `SpaceService.list()` now returns owned-space 401/403 failures rather than success with incomplete spaces, while other failures may still return delegated partial results. Non-auth domain codes remain, but 404/409 messages gain a `: HTTP <status> - <body>` suffix. Export the common HTTP response helper and validated capability classifier for SDK consumers.
