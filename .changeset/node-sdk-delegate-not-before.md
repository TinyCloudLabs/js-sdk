---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`TinyCloudNode.delegateTo` accepts `notBefore?: Date`, signed into the delegation's UCAN as `nbf` (whole seconds, floored like the expiry) on both the session-key and the runtime-grant paths, so a delegation can be backdated to cover an issuer clock that runs ahead of the node's. Without it nothing changes and no `nbf` is signed. It is refused when it is in the future (the node checks a delegation against its own clock with no leeway, so a future `nbf` fails activation), when it is not before the expiry that will actually be signed (including the session and runtime-grant caps), when it is not a valid `Date`, or when combined with `forceWalletSign`, whose SIWE path cannot carry it. `@tinycloud/web-sdk` re-exports the extended `DelegateToOptions`.

Details: TC-3172
