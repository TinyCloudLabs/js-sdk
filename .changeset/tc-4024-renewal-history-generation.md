---
"@tinycloud/sdk-core": patch
---

Accept signed renewal stamps that share a lease generation when verifying the node's renewal history. Generations must still be positive safe integers and cannot decrease; stamps must still strictly extend expiry and pass all signature and chain checks.

Details: TC-4024
