---
"@tinycloud/replica": patch
---

Depend on `@tinycloud/sdk-services` 3.3.1. The 3.3.1 stable release left replica pinned to 3.3.0, so installs of replica pulled a second copy of sdk-services and the kv-storage worker bundled that older copy.
