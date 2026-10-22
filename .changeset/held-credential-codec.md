---
"@tinycloud/sdk-core": minor
---

`@tinycloud/sdk-core/held-credentials` now exports `verifyHeldEmailCredential`, `selectDisclosures`, `sdHash`, and the `HeldEmailCredentialOptions` type. `verifyHeldEmailCredential` verifies a held email SD-JWT on its own, without a presentation proof or nonce, and checks that the credential subject is the authenticated owner. `sdHash` returns the base64url SHA-256 of the SD-JWT text, and `selectDisclosures` keeps only the named disclosures.

Details: TC-1454
