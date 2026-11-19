---
"@tinycloud/cli": patch
---

When a newer version is available, the CLI says so after a command succeeds. It checks the npm registry at most once a day, and the first command of the day can wait up to 3 seconds at exit for the check. `--quiet` hides the notice. Set `TC_NO_AUTO_UPDATE=1` to turn the check off; it's also off when `CI=true`.

Details: TC-2769
