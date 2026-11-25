---
"@tinycloud/cli": patch
---

The CLI reuses an owner's registry location for up to 60 seconds within one process. For an owner with no saved settings, a lookup that fails with a network error, timeout or server error is tried up to three times; if all fail, the command stops with `REGISTRY_UNAVAILABLE`. A 404 means the owner is unregistered and is not retried.

Details: TC-4373
