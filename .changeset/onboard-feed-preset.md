---
"@tinycloud/cli": minor
---

`tinycloud onboard --preset feed` signs an owner in with one OpenKey approval for the agent feed alone (SQL read, write and schema on the feed registry and the `xyz.tinycloud.tinychat/feed/` namespace, plus webhook register, subscribe, list and unregister on that namespace), instead of the default starting grant over every app's data and a second approval for the `account` space. Lasts 7 days. The default `onboard` is unchanged.

Details: TC-2490
