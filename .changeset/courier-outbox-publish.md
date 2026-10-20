---
"@tinycloud/courier": minor
---

`courier outbox add` publishes each item through a same-directory `.tmp-` file (fsynced, then hard-linked into place), so the sender never sees a partial `<itemId>.json`. Item files are mode 0640 (were 0644), and peer outbox directories are created setgid, mode 2750 (were 0755).
