---
"@tinycloud/web-sdk": patch
---

`TinyCloudWeb.requestPermissions(additional, { expiryMs })` now passes `expiryMs` to the step-up delegation it issues through `grantRuntimePermissions`, so the delegation expires at `now + expiryMs`. The expiry is capped at the session's expiry. The expiry applies when new permissions are requested. Calls without `expiryMs` are unchanged. A non-finite or non-positive `expiryMs` throws before the approval modal opens.

Details: TC-1777
