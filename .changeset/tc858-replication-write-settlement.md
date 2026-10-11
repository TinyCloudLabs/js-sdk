---
"@tinycloud/sdk-services": patch
---

Keep conditional KV write failures out of the replication committed epoch, and preserve timeout and abort error classifications for covered writes while marking their dispatch outcome ambiguous.
