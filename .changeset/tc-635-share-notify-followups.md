---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
---

`tc share publish --notify` refuses a share without `read` before publication. Domain invitations use `--to domain:<name> --notify --notify-to <mailbox>` with an owner-key profile and a node reporting 1.17.3 or later; unsupported nodes are refused before upload or registration. `tc share notify` documents its five-minute post-publication delivery window and reports a non-retryable partial failure with a republish hint after it closes. Confirmed repeats report `already-delivered` using encrypted sender history; a lost response remains a retryable failure rather than a false confirmation.
