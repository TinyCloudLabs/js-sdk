---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Add `sharing.delegateReceivedShare`, which exchanges a received `tc1` sharing
link for a strictly attenuated child delegation without exposing the parent
link or its embedded private key. Node `receive` now uses the same primitive
when auto-subdelegating to its current session key. Delegation revocation can
now be included in a consolidated manifest and uses the node's revocation
endpoint so descendants are invalidated rather than recording a no-op invoke.
