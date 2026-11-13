---
"@tinycloud/cli": patch
---

When a newer version is available, the CLI says so after a command finishes and shows the command to update. It checks the npm registry at most once a day. Set `TC_NO_AUTO_UPDATE=1` to turn this off; it's also off when `CI=true`.

Details: TC-2769
