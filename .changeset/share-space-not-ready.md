---
"@tinycloud/cli": patch
---

`tc share` now names a failure by class instead of a bare `INVALID_ARGUMENT` "share operation failed". A share upload the node answers with `404 Space not found` fails with `SPACE_NOT_READY` (exit 4). Other node failures map to `AUTH_REQUIRED` (401), `PERMISSION_DENIED` (403), `NOT_FOUND` (404), `NODE_UNAVAILABLE` (5xx, 408, 429), `NETWORK_ERROR` (unreachable node), `INVALID_ARGUMENT` (400, 422) or `NODE_REJECTED` (other 4xx), with the HTTP status in the message and the original error kept as `cause`. Remote response text never reaches the message. Errors with no status or network signal are unchanged.
