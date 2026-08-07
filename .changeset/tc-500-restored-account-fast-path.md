---
"@tinycloud/web-sdk": patch
---

Restore one unambiguous persisted TinyCloud account session for `share.receive({ identity: "auto" })` without consulting a wallet provider, preserving the account fast path and zero-OpenKey guest claiming.
