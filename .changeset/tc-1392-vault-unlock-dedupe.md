---
"@tinycloud/sdk-services": patch
---

Deduplicate in-flight vault unlocks and reuse in-memory vault key material so repeated OpenKey-backed unlock paths do not trigger duplicate signer prompts.
