---
"@tinycloud/operations": patch
"@tinycloud/mcp": patch
---

Restore discovery, reads, conditional writes and SQL queries for existing personal apps in `default/xyz.tinycloud.agent-data/`. Existing connections reuse their permissions and records in place instead of requiring approval for a new layout or silently creating replacement apps. Query layout selection is restored; the new-layout default, exact discovery-entry grants, and hosted/public tool sets remain unchanged.

Keep existing matching legacy record kinds in their original app, while retaining explicit Health Log and Recipes catalog routing. Give stale-copy markers a unique revision so concurrent same-day writes cannot be cleared by an older rebuild.

Details: TC-2416
