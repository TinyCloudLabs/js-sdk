---
"@tinycloud/web-sdk": patch
---

A failed or timed-out browser replica startup recovery no longer gates the replica until the page reloads: stamp admission re-runs the bounded recovery (at most twice more per page) and still refuses while recovery fails.
