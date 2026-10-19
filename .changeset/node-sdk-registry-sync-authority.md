---
"@tinycloud/node-sdk": patch
---

Sign-in skips the background account registry sync when the session's signed ReCap does not cover the account index read (`tinycloud.sql/read` on the owner's `account` space, `account` database). A scoped session, such as a replica-enabled CLI OpenKey login, no longer sends a request that is always refused with 401 and logs an "account index initialization failed" warning. A session with no parseable ReCap still syncs as before.
