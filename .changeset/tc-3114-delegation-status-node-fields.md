---
"@tinycloud/sdk-core": patch
---

`getDelegationStatus` works against TinyCloud nodes 1.26.0 and later. Those nodes add `effective_expiry` and `renewal_history` to the `/delegation/status` response, and the status check rejected any response with an extra field, so every call returned `INVALID_TOKEN` ("Node returned an invalid delegation status response"). The two fields are now accepted when present (`effective_expiry` an integer or null, `renewal_history` a list of node-signed renewal stamps), and a response without them, from an older node, is still accepted. Any other unknown field, a malformed stamp and an inconsistent status are still refused.

Details: TC-3114
