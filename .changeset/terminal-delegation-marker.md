---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
---

`disableSubDelegation: true` now sets the node's terminal marker (the UCAN fact `xyz.tinycloud.policy/delegationMode: "terminal"`), so the node refuses any delegation that cites the result as a parent. It applies to `createDelegation`, the `space.delegations.create` wiring, and the new `delegateTo` option of the same name; the returned delegation reports `disableSubDelegation: true`. The delegate can still use the delegation directly, but a wallet-mode `useDelegation`, which chains a new session from it, is refused by the node.

What breaks: wallet-signed delegations cannot carry the marker, so `disableSubDelegation: true` now throws instead of issuing a delegation that can still be re-delegated. This covers `createSubDelegation`, `delegateTo` with `forceWalletSign`, and `createDelegation` when the requested capabilities are outside the current session. sdk-core exports `TERMINAL_DELEGATION_FACT` and `markDelegationTerminal` (TC-1436).
