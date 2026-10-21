---
"@tinycloud/courier": minor
---

`courier outbox add` publishes each item through a same-directory `.tmp-` file (fsynced, then hard-linked into place), so the sender never sees a partial `<itemId>.json`. Item files and ledger entries are mode 0600 (were 0644), and peer outbox directories are created setgid, mode 2750 (were 0755). `outbox add` writes canonical bytes (`canonicalJson(item)` plus a newline) and the sender accepts only those bytes.
