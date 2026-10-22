---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": patch
---

Add `allowSubDelegation` to share generation. It defaults to `true`, which keeps today's behavior. Passing `false` issues a terminal delegation: the node refuses onward delegation of the share. A non-transferable share must be covered by an existing session-key delegation; it is refused when none covers it, and the wallet root path is not used for it.

A non-transferable share is received with `receive(link, { autoSubdelegate: false })`; the default auto-subdelegation is refused for it.

Details: TC-1801
