---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

Encryption network invocations are re-signed with the key of the session that built them, so a sign-in with a manifest creates the account encryption network. Decrypting for an account with no default encryption network reports that the account needs to sign in again with a current SDK.

Details: TC-1910
