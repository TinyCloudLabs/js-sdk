---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
"@tinycloud/sdk-services": patch
---

Keep published segment-aware replica selection unchanged while using sdk-core capability containment only for authority. Replication now requires authority over the selected namespace, including descendants of bare selectors; LIST local serving requires complete selection coverage, and nested LIST pending writes force network fallback or cursor restart.
