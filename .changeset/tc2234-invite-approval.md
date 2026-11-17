---
"@tinycloud/courier": minor
"@tinycloud/share-envelope": minor
---

**Not available yet.** This adds the code for a per-invitation owner approval behind the hidden `courier invite --mode email`. OpenKey does not handle invitation approvals yet, so a real invitation can't complete, and nothing is created or sent before an approval. The design: the approval request carries the recipient, session name and dates; OpenKey chooses the Share key and returns a grant for that one key (`key.create` and `decrypt`), valid until the invitation expires (at most 24 hours). Courier writes the pending invitation before asking, sends nothing until the approval is verified, and uses the approved grant only for that invitation's key; the main Courier grant is not changed. Running the same command again continues a pending invitation. Available now: `@tinycloud/share-envelope/links` adds an optional strict `context` to the approval request (with no permissions) and `buildShareInvitationApprovalSpec`.

Details: TC-2234
