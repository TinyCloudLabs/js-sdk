---
"@tinycloud/cli": patch
---

When a newer version is available, the CLI says so after a command succeeds in a terminal. It checks the npm registry at most once a day in the background, so no command waits for it, and the notice appears on a later command. Beta installs are also told about a newer stable release. `--quiet`, `--json` and `tinycloud courier` never show it. Set `TC_NO_AUTO_UPDATE=1` to turn the check off; it's also off when `CI` is set to anything but `false` or `0`.

Details: TC-2769
