---
"@tinycloud/sdk-services": patch
---

Probe for the SQL migrations table before reading applied IDs so first sign-in on a fresh database avoids a failing request while up-to-date databases remain read-only.
