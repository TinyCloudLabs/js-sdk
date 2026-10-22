---
"@tinycloud/web-sdk": minor
---

`TinyCloudWeb.requestPermissions(additional, { expiryMs })` now passes `expiryMs` to the step-up delegation it issues through `grantRuntimePermissions`, so the delegation expires at `now + expiryMs`. The expiry is capped at the session's expiry. The expiry applies when new permissions are requested. Calls without `expiryMs` are unchanged. A non-finite or non-positive `expiryMs` throws before the approval modal opens.

Decrypt grants (including wildcards) with `expiryMs` over one hour throw `DECRYPT_EXPIRY_TOO_LONG` before the approval modal opens.

`TinyCloudWeb.hasPermissions(entries)` returns whether the session or an unexpired runtime grant covers all entries. It never prompts.

Details: TC-1777
