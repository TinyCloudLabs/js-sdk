---
"@tinycloud/node-sdk": patch
---

Prepare the email credential issuer pin for a replacement witness key while preserving `did:web:issuer.credentials.org#controller` and the existing descriptor digests. Credentials issued under the previous key will no longer verify; holders must re-verify after upgrading to the replacement-key release.

This draft deliberately contains `UNKNOWN_NEW_WITNESS_KEY`, which is not a usable Ed25519 public key. Email credential verification fails closed until the verified replacement key is supplied. Do not merge or release this draft with the unknown value.

Details: TC-2498
