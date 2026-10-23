---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Manifest sign-in and session preparation refuse a permission with a non-empty caveat by throwing the existing `CaveatedDelegationUnsupportedError` (`CAVEATED_DELEGATION_UNSUPPORTED`) before any request or signature. Caveats that are absent, `[]`, `[{}]` or `[{}, {}]` are accepted.

Refusing call sites: `TinyCloudNode.signIn`, `signInWithOpenKey` and `createOwnerDelegation`/`createSubDelegation` permissions; `NodeUserAuthorization.signIn`, `prepareSessionForSigning`, `signInWithOpenKey` and `createBootstrapSession`; `TinyCloudWeb.signIn` (before any persisted session is restored). `@tinycloud/sdk-core` exports the `hasNonEmptyCaveat` predicate.

Details: TC-1855
