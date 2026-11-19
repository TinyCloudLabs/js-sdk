---
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

Vault and secrets requests to the production node now go to its dedicated address, and so do activations of sessions and grants that cover vault data. Self-hosted nodes are unchanged.

Details: TC-2944
