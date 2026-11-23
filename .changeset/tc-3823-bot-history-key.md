---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`keys.encrypt` accepts a caller-verified public key descriptor for a named key and seals to it without contacting the node. The descriptor must match the network and key path. The caller verifies its origin and freshness. `descriptor` cannot be used with `ensureKey: true`.

`BOT_HISTORY_KEY_PATH` is reserved for TinyChat bot history. The `tinychat-bot-history` scope cannot hold secrets. A runtime permission request can grant decrypt or key creation on that exact key, and the web SDK keeps an approved grant for that key across reloads in the same session.

Details: TC-3823
