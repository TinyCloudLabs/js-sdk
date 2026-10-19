---
"@tinycloud/cli": patch
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`tc delegation create` now signs and activates the delegation through `delegateTo` and prints its CID. `tc delegation list` and `tc delegation info` use the node's account delegation query (`POST /delegation/query`), which includes delegations signed by the session key; `account.delegations.list` does not return those. `create` reads the delegation back through that query before it reports success, and `--to` accepts a `did:key` with a `#fragment`. Previously `create` and `list` sent `tinycloud.delegation/create` and `tinycloud.delegation/list` invocations that the node does not handle (it answered an empty 200, surfaced as a JSON parse error), and `info` called a method that did not exist.

Breaking: removed `DelegationManager.create()` (use `TinyCloudNode.delegateTo()`), `DelegationManager.list()` (use `account.delegations.list()`), `TinyCloudNode.delegate()` (use `delegateTo()`), `TinyCloudNode.listDelegations()` (use `account.delegations.list()`), and the web-sdk `TinyCloudWeb.delegate()` (use `delegateTo()`) and `TinyCloudWeb.listDelegations()` (use `account.delegations.list()`). They sent invocations the node never handled, so they never worked. Also removed the `delegationManager` option from `SharingService` config; sharing uses `createDelegation` or `createDelegationWasm`.

`TinyCloudNode.delegateTo()` now throws when the node answers 200 but lists a target space under `skipped` (a space it does not host), naming that space; this used to look like success. `DelegationManager.getChain()` and `checkPermission()` now return an `UNSUPPORTED_OPERATION` error when the node answers with an empty body.
