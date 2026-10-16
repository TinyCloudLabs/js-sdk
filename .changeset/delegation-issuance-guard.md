---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/cli": patch
---

Restrict high-privilege delegation abilities in creation flows with `REVOKE_GRANT_DISABLED`. Scoped grants and direct owner revocation of an existing delegation remain available. Session-only CLI profiles without CID authority can use the account dashboard or a local owner key.
