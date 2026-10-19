---
"@tinycloud/node-sdk": patch
---

`delegateTo`, `createDelegation` and `space.delegations.create` now throw for `disableSubDelegation: true` addressed to a `did:pkh` recipient, before anything is signed. A wallet-mode `useDelegation` of a terminal grant is refused by the node (`terminal-parent-cannot-redelegate`), so the recipient could never use it. Grant the recipient's session-key DID instead, or drop the flag (TC-1448).

What breaks: calls that passed `disableSubDelegation: true` with a `did:pkh` delegate (including an ENS name that resolves to one) used to return a grant the wallet recipient could not activate; they now throw.
