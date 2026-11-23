---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

A manifest permission path can hold the token `{owner}`, which resolves to the signing account's `did:pkh:eip155:<chain id>:<checksummed address>` at sign-in. The digest sent to OpenKey covers the manifest as published, with the token in place, so one published manifest serves every account. A manifest without the token sends the same request and digest as before. The token is accepted only inside `permissions[].path`; anywhere else (a name, a key, a space, an additional delegate) the sign-in is refused before OpenKey is asked. `@tinycloud/sdk-core` exports `resolveManifestOwner`, `manifestUsesOwnerPlaceholder` and `MANIFEST_OWNER_PLACEHOLDER`, and the presentation envelope may carry an `owner` hint that OpenKey checks against the owner it derives itself. A restored web session resolves the token with its own address and chain id.

Details: TC-3731
