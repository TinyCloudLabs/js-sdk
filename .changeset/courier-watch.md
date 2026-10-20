---
"@tinycloud/courier": minor
---

Add `courier watch`: subscribes to each paired peer's `to/<me>/` and your `me/approvals/` through write hooks (25 s tickets), polls every 60 s as the fallback, mirrors new messages, peer `meta.json` and peer tasks into `me/mirror/`, advances receipts, and wakes per thread after a 30 s debounce (`inform` never wakes). State lives in `me/state/watch.json`. This release logs the wake (`--wake none`); wake adapters follow.
