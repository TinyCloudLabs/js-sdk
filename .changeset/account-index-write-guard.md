---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Account index writes are sent only when the session can write the index (`tinycloud.sql` write and schema on the account database). A session without that access skips the index writes. Account reads and writes through the registry records don't depend on that access.

Details: TC-3688
