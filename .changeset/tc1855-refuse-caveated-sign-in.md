---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Manifest sign-in and session preparation now refuse a permission with a non-empty caveat, instead of silently dropping the caveat and signing a wider session. The refusal is the existing `CaveatedDelegationUnsupportedError` (`CAVEATED_DELEGATION_UNSUPPORTED`), thrown before any request or signature. Caveats that are absent, `[]`, `[{}]` or `[{}, {}]` behave as before.

Covered: `TinyCloudNode.signIn` and `signInWithOpenKey`, `NodeUserAuthorization.signIn`, `prepareSessionForSigning`, `signInWithOpenKey` and `createBootstrapSession`, `TinyCloudNode.createOwnerDelegation` permissions, and `TinyCloudWeb.signIn` (before any persisted session is restored). `@tinycloud/sdk-core` exports `hasNonEmptyCaveat`, `assertNoCaveatedPermissions` and `assertNoCaveatedManifestPermissions`.

Details: TC-1855
