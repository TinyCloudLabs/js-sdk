---
"@tinycloud/web-sdk": patch
---

A browser replica startup recovery that outlives its 3 s bound and later finishes cleanly now re-admits the replica without a page reload. Only one recovery runs at a time. While a recovery is still running, stamp admission waits up to 3 s for it without spending a retry. A late clean startup finish triggers one fresh recovery under the origin gate, and only that fresh report can re-admit the replica. A failed recovery is retried at stamp admission at most twice per page. Admission still refuses while recovery fails, and a deny made in the meantime still refuses the old stamp. If another tab holds the origin gate lock long enough that these retries run out, the replica stays gated (fail closed) until a reload.
