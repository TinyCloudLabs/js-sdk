---
"@tinycloud/share-envelope": minor
"@tinycloud/sdk-core": patch
"@tinycloud/share-sdk": patch
---

`@tinycloud/share-envelope` exports `POLICY_ROOT_MAX_LIFETIME_SECONDS` (31 days, in seconds), the longest a proofless policy root may last and so the longest an addressed share can stay readable. `@tinycloud/sdk-core` and `@tinycloud/share-sdk` now import this one definition instead of each holding the same value; the signer's bound and its error message are unchanged.

Details: TC-2234
