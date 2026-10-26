---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Manifests can declare named keys in the app's key namespace, with an optional `keys_app_id`. Sign-in includes the declared key permissions when the node supports named keys, prepares creatable key paths, and exposes the signed-in named-key client through `keys`.

Details: TC-1977
