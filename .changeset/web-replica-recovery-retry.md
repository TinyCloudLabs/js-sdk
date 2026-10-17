---
"@tinycloud/web-sdk": patch
---

Browser replica startup recovery no longer leaves the replica gated until a page reload. Only one recovery runs at a time. While a recovery is still running, including a startup recovery that outlived its 3 s bound, stamp admission waits up to 3 s for it without spending a retry. A startup recovery that finishes cleanly after its bound triggers one fresh recovery under the origin gate, and only that fresh report can re-admit the replica. A failed recovery is retried at stamp admission at most twice per page. Admission still refuses while recovery fails, and a deny made in the meantime still refuses the old stamp.
