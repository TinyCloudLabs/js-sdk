---
"@tinycloud/sdk-core": minor
---

Preserve typed HTTP status on space hosting, public-space, delegation import, and policy runtime failures. Authorization failures in service results now use `AUTH_UNAUTHORIZED` with `meta.status`; thrown errors expose `status`. Messages retain the Node response status and body, while existing result shapes and non-authorization domain codes remain intact.
