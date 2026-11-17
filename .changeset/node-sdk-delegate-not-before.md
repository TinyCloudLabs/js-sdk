---
"@tinycloud/node-sdk": minor
---

`TinyCloudNode.delegateTo` accepts `notBefore?: Date`, signed into the delegation's UCAN as `nbf` (whole seconds, floored like the expiry) on both the session-key and the runtime-grant paths. Without it nothing changes: no `nbf` is signed. It is refused when it is after the expiry that will actually be signed (including the session cap), more than 5 minutes in the future, not a valid `Date`, or combined with `forceWalletSign`, whose SIWE path cannot carry it.

Details: TC-3172
