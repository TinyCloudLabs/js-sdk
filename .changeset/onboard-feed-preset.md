---
"@tinycloud/cli": minor
---

`tinycloud onboard --preset feed` signs an owner in with one OpenKey approval for the agent feed alone (SQL read, write and schema on the feed registry and the `xyz.tinycloud.tinychat/feed/` namespace, plus the webhook subscription on that namespace), instead of the default starting grant over every app's data and a second approval for the `account` space. Lasts 7 days. The default `onboard` is unchanged. `feed connect` now waits up to 30 seconds when the node answers `Space not found` (a brand-new account's space is still being hosted), then ends with `SPACE_SETUP_PENDING` and a clear message to run it again in a minute.

Details: TC-2490
