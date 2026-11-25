---
"@tinycloud/operations": patch
---

`invokeOperation` and the authenticated and restored runtime constructors take an optional last parameter, `registryVerdictCache`, to share registry lookups. Callers that leave it out look up the registry on each call.

Details: TC-4373
