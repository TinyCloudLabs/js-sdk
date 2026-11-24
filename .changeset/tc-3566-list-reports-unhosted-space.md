---
"@tinycloud/sdk-services": minor
---

`KVService.list()` on a space the node doesn't host fails with the new error code `SPACE_NOT_HOSTED`, so an app can tell an empty, not-yet-hosted space from a network failure. The error message and `meta.status` (404) are unchanged. Every other list failure returns `NETWORK_ERROR`.

Upgrading: code that treats any `NETWORK_ERROR` from `list()` as a failure should handle `SPACE_NOT_HOSTED` too.

Details: TC-3566
