---
"@tinycloud/node-sdk": minor
---

`activateValidatedRuntimeDelegation` takes a new `authorize` option. It sees the capabilities read from the signed delegation before anything is activated or installed, and returning `false` refuses the delegation.
