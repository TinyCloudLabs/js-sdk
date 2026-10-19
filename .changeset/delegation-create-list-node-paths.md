---
"@tinycloud/cli": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`tc delegation create` now signs and activates the delegation through `delegateTo`, reads it back through the node's account delegation query, and prints its CID only once the node lists it as active (`DELEGATION_NOT_CONFIRMED` otherwise). `tc delegation list` and `tc delegation info` use that query (`POST /delegation/query`) via `account.delegations.query()`, which includes delegations signed by the session key; `list` gains `--space`, and `--to` accepts a `did:key` with a `#fragment`. Previously `create` and `list` sent `tinycloud.delegation/create` and `tinycloud.delegation/list` invocations that the node does not handle (it answered an empty 200, surfaced as a JSON parse error), and `info` called a method that did not exist.

A plain `tc auth login` now also requests `tinycloud.delegation/list` on the default space (OpenKey's default grant omits it). A session that lacks it, on the account space and its own space, gets a `PERMISSION_DENIED` error saying to run `tc auth login` again. `DelegationManager.query()` signs for the account space and falls back to the session's own space when the node refuses (403).

Breaking: removed `DelegationManager.create()` (use `TinyCloudNode.delegateTo()`), `DelegationManager.list()` (use `account.delegations.query()`), `TinyCloudNode.delegate()` (use `delegateTo()`), `TinyCloudNode.listDelegations()` (use `account.delegations.query()`), and the web-sdk `TinyCloudWeb.delegate()` (use `delegateTo()`) and `TinyCloudWeb.listDelegations()` (use `account.delegations.query()`). They sent invocations the node never handled, so they never worked. `account.delegations.list()` is not a replacement: it reads the SQL index and omits session-signed delegations. Also removed the `delegationManager` option from `SharingService` config; sharing uses `createDelegation` or `createDelegationWasm`.

`TinyCloudNode.delegateTo()` takes a new `requireActivation` option: when set, it throws when the node answers 200 but lists a target space under `skipped` (a space it does not host), naming that space; this used to look like success. It is off by default, since grants to a not-yet-hosted space (e.g. secrets) are valid. `tc delegation create` sets it. `DelegationManager.getChain()` and `checkPermission()` now return an `UNSUPPORTED_OPERATION` error when the node answers with an empty body.
