---
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
---

Personal-app context accepts an optional `app` and `access` (`read` or `change`, default `change`) to request the app's folder and app list together in one approval. Omitting `app` retains per-call approvals. New apps separately check the older catalog when needed.

Details: TC-2416
