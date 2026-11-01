---
"@tinycloud/sdk-core": patch
---

A manifest entry on the default network's `share/` prefix may carry `key.create` beside `decrypt`, so one sign-in can create the per-share keys an addressed share is encrypted under. The owner address must be EIP-55 checksummed. Everything else stays refused: `key.create` on a whole network, on any other prefix or on an exact key (that is the runtime request), any other action on the share prefix, and a non-default network. A runtime request for `key.create` still names one exact key.

Details: TC-2242
