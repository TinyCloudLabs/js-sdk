---
"@tinycloud/cli": minor
---

Add headless email-code receive to `tinycloud share receive`: `--request-code` emails a code to the owner's recipient mailbox, and `--resume <id> --code <code>` completes it. Pending state is held in an owner-only file under the CLI config directory for at most 15 minutes. Presentation building and share open are not yet wired and fail closed with `presentation builder unavailable` / `share open unavailable`.

Details: TC-1757
