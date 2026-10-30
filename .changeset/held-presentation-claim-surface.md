---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

Held credentials for the claim screen. `@tinycloud/sdk-core/held-credentials` adds `buildHeldPresentationSiwe` and `checkReturnedPresentation`, and `verifyHeldEmailCredential` now also returns the signed `issuedAt`. `@tinycloud/web-sdk/credentials` now exports `createAccountHolderSigner`, `storeHeldCredential`, `findHeldCredential`, `acquireHeldCredential` and a new `listHeldEmailCredentials`, which returns all of one account's valid held email credentials: owner only; expired, revoked, unverifiable and within-10-minutes-of-expiry records are left out (the same margin as `findHeldCredential`); newest `issuedAt` first. That entry now imports `@tinycloud/sdk-core` instead of bundling a copy, so parse the issuer set with `parseIssuerSet` from `@tinycloud/sdk-core/held-credentials` and `CredentialError` is sdk-core's own class. `HeldMatch` gains `recordId`, `email`, `issuedAt`, `expiresAt` and `issuer`, all read from the re-verified credential. `@tinycloud/node-sdk` keeps the held profile disabled and no longer resumes a pending code request of another profile for the same address.

Details: TC-1454
