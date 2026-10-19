---
"@tinycloud/replica": patch
---

Add the Chromium browser acceptance harness for read-through replication: `TinyCloudWeb` with the real IndexedDB adapter against the pinned node, covering sign-in, replica and network reads, offline fallback, sign-out and deny failure paths, account switch, two-tab behaviour and the flag-off byte-identical check. CI runs it with `TC858_ACCEPTANCE_STRICT=1`, which fails on any todo or skip.
