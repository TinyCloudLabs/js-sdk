---
"@tinycloud/cli": patch
---

`tc delegation revoke` now asks OpenKey for its one-use revoke authority with a 5-minute lifetime, so that authority expires a few minutes after the revoke instead of lasting OpenKey's default 7 days. Local-key owners get the same bounded lifetime. The command also refuses to request one-use OpenKey authority without an explicit lifetime.

Details: TC-1785
