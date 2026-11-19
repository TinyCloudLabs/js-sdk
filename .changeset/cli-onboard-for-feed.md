---
"@tinycloud/cli": minor
---

`onboard --for feed` asks the owner for the Feed only: one approval on the applications space for read, write and schema on the Feed's databases and for notifications of new answers, for 7 days. It has no second approval for the account space, and no whole-space access to the owner's apps. `onboard --expiry <number><m|h|d|w>` sets how long the approval lasts, up to 30 days; plain `onboard` keeps its two approvals and its 30 days.

Details: TC-3293
