---
"@tinycloud/replica": patch
---

SQLite replica grant installs and recomputes keep each grant's stored consent deadline and anchor from ever moving later. A compact session reopen with no owner anchor falls back to the first-install anchor, which could otherwise raise the deadline by up to the grant TTL and keep serving local reads past the owner's consent deadline.
