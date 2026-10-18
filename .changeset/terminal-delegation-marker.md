---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
---

`disableSubDelegation: true` now sets the node's terminal marker (the UCAN fact `xyz.tinycloud.policy/delegationMode: "terminal"`), so the node refuses any delegation that cites the result as a parent. It applies to `createDelegation`, the `space.delegations.create` wiring, and the new `delegateTo` option of the same name; the returned delegation reports `disableSubDelegation: true`. sdk-core exports `TERMINAL_DELEGATION_FACT` and `markDelegationTerminal` (TC-1436).

Behaviour change, released as `minor` because the repository's versioning rule allows agents only `minor` or `patch` (a major needs a maintainer's sign-off). What breaks:
- `disableSubDelegation: true` now throws instead of issuing a wallet-signed delegation that can still be re-delegated: in `createSubDelegation`, in `delegateTo` with `forceWalletSign`, and in `createDelegation` when the requested capabilities are outside the current session.
- A terminal delegation still works for a delegate that uses it directly, but a wallet-mode `useDelegation`, which chains a new session from it, is refused by the node.
