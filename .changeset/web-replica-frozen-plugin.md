---
"@tinycloud/web-sdk": patch
---

`browserReplicaPlugin` and its loaders are frozen, and `registerBrowserReplica` registers a frozen copy, so a same-realm script cannot swap the recovery guard or a replica loader at runtime.
