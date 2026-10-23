---
"@tinycloud/cli": patch
---

`tc share publish --to email:|did:|domain:` on a sign-in that does not hold decrypt on the owner's default network asks for one decrypt approval through OpenKey device authorization, then continues. The request is decrypt alone. It waits up to 10 minutes for the owner and asks for the time left until the sign-in ends, less that wait and a clock allowance, so the grant ends no later than the sign-in. The CLI checks the signed grant against the request, stores it on the profile, and asks nothing further on that sign-in. Nothing is uploaded, linked or invited until the approval completes. A declined or expired approval exits 5 with `DECRYPT_APPROVAL_NOT_COMPLETED`; other failures keep their own error codes. `tc enable share` and `builtin:share-publishing` are unchanged, and device login still refuses `tinycloud.encryption` and the secrets space.

Details: TC-1859
