---
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/cli": patch
---

Use resource routing and destination identity checks for policy, delegation, sharing and identity operations on Node/Web-owned SDK objects. Preserve per-space write outcomes and bind newly issued proofs to the selected destination.

Standalone Core objects and low-level policy functions still trust a host explicitly supplied by the caller; they do not consult the registry without a resource transport callback. Received-share and restored-data destinations require that callback. Node-local resource names without a routing owner are refused by the Node/Web transport rather than mapped to the current account.

Keep new-user onboarding tied to constructor-supplied hosts or an explicit code-supplied sign-in override, independently of restored session hints; registered routes still take precedence. Bind hosting, policy delivery, publication and grant activation to the initiating service graph across asynchronous preparation, response validation and signing. Web wrapper calls refuse account/session replacement before dispatch, and static share receiving uses the verified parent and registry-routed share actor rather than the link's recorded host.

Refuse redirects for credential- or body-bearing Core and Node requests, including encryption-network creation. Preserve typed routing failures and partial-write receipts, metadata and causes through delegation and sharing Result adapters rather than reporting a partial side effect as a generic network failure.

The unauthenticated, bodyless replication-restoration `/info` hint preflight remains an explicit exception so local replica hydration does not wait for a registry lookup.

Details: TC-2594
