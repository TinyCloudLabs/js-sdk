---
"@tinycloud/cli": patch
---

`tc share publish --to email:|did:|domain:` on a sign-in that does not hold decrypt on the owner's default network asks for one decrypt approval through OpenKey device authorization, then continues. The request is decrypt alone and lasts as long as the sign-in's remaining lifetime. The CLI checks the signed grant against the request, stores it on the profile, and asks nothing further on that sign-in. Nothing is uploaded, linked or invited until the approval completes. A declined or expired approval exits 5 with `DECRYPT_APPROVAL_NOT_COMPLETED`; other failures keep their own error codes. `tc enable share` and `builtin:share-publishing` are unchanged, and device login still refuses `tinycloud.encryption` and the secrets space.

Details: TC-1859
