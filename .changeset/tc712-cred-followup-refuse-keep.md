---
"@tinycloud/courier": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": minor
---

`courier credential show` no longer deletes a stored credential that fails offline re-verification. The record is refused with `credential-record-invalid` and kept under `COURIER_HOME/credentials/` for inspection. Lifecycle drops are unchanged: a credential within 60 seconds of its own expiry, or older than the 3600-second maximum age, is still deleted.

`@tinycloud/node-sdk/credentials` also exports the `StoredEmailProofInput` type.

`@tinycloud/web-sdk/credentials` adds `verifyStoredEmailProof` and the `StoredEmailProofInput` and `StoredEmailProofRecord` types, so headless clients can re-verify a stored email-proof credential offline without importing `@tinycloud/node-sdk` directly.

Details: TC-712
