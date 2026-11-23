---
"@tinycloud/cli": minor
---

`tinycloud onboard` can return a private TinyCloud One setup link after a new apps approval. The page shows the connected agent and app list. The link is read-only and lasts up to 24 hours, no longer than the approval. JSON output returns `handoff.url` and `handoff.expiresAt` when a link is available, or `handoff.message` otherwise.

Details: TC-3302
