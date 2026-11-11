---
"@tinycloud/courier": minor
"@tinycloud/share-envelope": minor
---

`courier invite --mode email` asks the owner for one approval per invitation. The approval request carries the recipient, session name and dates; OpenKey chooses the Share key and returns a grant for that one key (`key.create` and `decrypt`), valid until the invitation expires (at most 24 hours). Courier writes the pending invitation before asking, sends nothing until the approval is verified, and uses the approved grant only for that invitation's key; the main Courier grant is not changed. Run the same command again to continue a pending invitation. `@tinycloud/share-envelope/links` adds an optional strict `context` to the approval request (with no permissions) and `buildShareInvitationApprovalSpec`.

Details: TC-2234
