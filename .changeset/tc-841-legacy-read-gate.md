---
"@tinycloud/cli": patch
---

Require a persisted owner replica stamp and active profile gate for legacy local replica get, list, and status. Serialize reads and output with sign-out denial so deferred revocation cannot serve retained replica data.
