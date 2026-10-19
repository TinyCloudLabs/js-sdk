---
"@tinycloud/cli": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

`tc delegation create` now signs and activates the delegation through `delegateTo` and prints its CID. `tc delegation list` uses the account-wide delegation query, as `tc account delegations list` does. Both previously sent `tinycloud.delegation/create` and `tinycloud.delegation/list` invocations that the node does not handle: it answered with an empty 200, which surfaced as a JSON parse error.

Removed the non-functional `DelegationManager.create()` and `list()`, `TinyCloudNode.delegate()` and `listDelegations()`, and the matching web-sdk methods. Use `delegateTo()` to create and `account.delegations.list()` to list. `DelegationManager.getChain()` and `checkPermission()` now return an `UNSUPPORTED_OPERATION` error when the node answers with an empty body.
