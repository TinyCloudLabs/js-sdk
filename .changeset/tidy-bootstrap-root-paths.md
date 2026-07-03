---
"@tinycloud/bootstrap": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Fix bootstrap space manifests granting unusable root capabilities. The default, applications, and public space manifests declared kv/sql permissions with `path: "/"`, which the recap encoder joined into resources like `applications/sql//` (double slash). The node's byte-prefix resource matching can never extend such a resource, so every invocation riding a bootstrap session delegation was rejected with "Unauthorized Action" — this is what broke Listen's first conversations query after OpenKey auto-sign bootstrap. Root permissions now use `path: ""`, which encodes as `applications/sql` and correctly covers all paths under the service.
