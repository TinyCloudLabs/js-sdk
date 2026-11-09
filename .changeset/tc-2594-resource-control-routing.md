---
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/cli": patch
---

Use resource routing and destination identity checks for policy, delegation, sharing and identity operations on Node/Web-owned SDK objects. Preserve per-space write outcomes and bind newly issued proofs to the selected destination.

Standalone Core objects and low-level policy functions still trust a host explicitly supplied by the caller; they do not consult the registry without a resource transport callback. Received-share and restored-data destinations require that callback. Node-local resource names without a routing owner are refused by the Node/Web transport rather than mapped to the current account.

The unauthenticated, bodyless replication-restoration `/info` hint preflight remains an explicit exception so local replica hydration does not wait for a registry lookup.

Details: TC-2594
