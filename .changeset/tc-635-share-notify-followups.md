---
"@tinycloud/cli": minor
"@tinycloud/share-sdk": minor
---

`tc share publish --notify` refuses a share without `read` before publication. Domain invitations use `--to domain:<name> --notify --notify-to <mailbox>` on a node reporting 1.17.3 or later; a session-only publisher may deliver its own signed policy when its sender DID matches the policy owner. Unsupported nodes are refused before upload or registration, and standalone `tc share notify` checks stored read permission and domain node support before delivery. Notifications use an atomic, profile-locked sender-history confirmation; a history write failure warns without hiding successful delivery, and concurrent revocation or invitations retain each other's fields. Publish JSON includes the additive `notification` result, including non-retryable window failures. `ShareNotifyError.code` remains `"delivery-failed"`; its optional `reason` distinguishes an expired delivery window. Confirmed repeats report `already-delivered` using encrypted sender history; a lost response remains a retryable failure rather than a false confirmation.
