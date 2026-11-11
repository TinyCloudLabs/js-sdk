---
"@tinycloud/share-sdk": minor
---

`publishTargetShare` and the target publish input accept an optional `expiresInMs`, the relative expiry the caller asked for as a duration in milliseconds, and pass it to the target adapter unchanged. It lets a caller recognise a rerun of the same relative choice; it does not change how the expiry is computed.

Details: TC-2234
