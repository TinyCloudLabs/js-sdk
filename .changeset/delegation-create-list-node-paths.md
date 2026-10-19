---
"@tinycloud/cli": patch
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`tc delegation create` now signs and activates the delegation through `delegateTo` and prints its CID. `tc delegation list` and `tc delegation info` use the account-wide delegation query, as `tc account delegations list` does. Previously `create` and `list` sent `tinycloud.delegation/create` and `tinycloud.delegation/list` invocations that the node does not handle (it answered an empty 200, surfaced as a JSON parse error), and `info` called a method that did not exist.

Breaking: removed `DelegationManager.create()` (use `TinyCloudNode.delegateTo()`), `DelegationManager.list()` (use `account.delegations.list()`), `TinyCloudNode.delegate()` (use `delegateTo()`), `TinyCloudNode.listDelegations()` (use `account.delegations.list()`), and the web-sdk `TinyCloudWeb.delegate()` (use `delegateTo()`) and `TinyCloudWeb.listDelegations()` (use `account.delegations.list()`). They sent invocations the node never handled, so they never worked. Also removed the `delegationManager` option from `SharingService` config; sharing uses `createDelegation` or `createDelegationWasm`.

`DelegationManager.getChain()` and `checkPermission()` now return an `UNSUPPORTED_OPERATION` error when the node answers with an empty body.
