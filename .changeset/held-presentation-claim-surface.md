---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

Held credentials for the claim screen. `@tinycloud/sdk-core/held-credentials` adds `buildHeldPresentationSiwe` and `checkReturnedPresentation`, and `verifyHeldEmailCredential` now also returns the signed `issuedAt`. `@tinycloud/web-sdk/credentials` now exports `createAccountHolderSigner`, `storeHeldCredential`, `findHeldCredential`, `acquireHeldCredential` and a new `listHeldEmailCredentials`, which returns all of one account's valid held email credentials (owner only; expired, revoked and unverifiable records are left out; newest `issuedAt` first). `HeldMatch` gains `recordId`, `email`, `issuedAt`, `expiresAt` and `issuer`, all read from the re-verified credential. `@tinycloud/node-sdk` keeps the held profile disabled and no longer resumes a pending code request of another profile for the same address.

Details: TC-1454
