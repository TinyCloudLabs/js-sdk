---
"@tinycloud/share-sdk": minor
---

Recipient challenge, delegation, import, and decrypt HTTP rejections now expose a typed response status instead of only embedding it in the message. Notification delivery no longer retries a typed 401/403 refusal and reports `retryable: false` after the first attempt; transient failures retain the existing retry budget.
