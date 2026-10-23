---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Manifest sign-in and session preparation refuse a permission that carries caveats by throwing the existing `CaveatedDelegationUnsupportedError` (`CAVEATED_DELEGATION_UNSUPPORTED`) before any request or signature. Absent, `[]` and `[{}]` caveats are accepted; any other set, including `[{}, {}]`, is refused, the same rule the delegation paths apply through `recapCaveatsEqual`.

Refusing call sites: `TinyCloudNode.signIn`, `signInWithOpenKey`, `createOwnerDelegation` and `createSubDelegation` permissions; `NodeUserAuthorization.signIn`, `prepareSessionForSigning`, `signInWithOpenKey` and `createBootstrapSession`; `TinyCloudWeb.signIn` (before any persisted session is restored).

Details: TC-1855
