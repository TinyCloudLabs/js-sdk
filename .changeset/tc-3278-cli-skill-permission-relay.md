---
"@tinycloud/cli": patch
---

The `tinycloud-cli` skill's install page (`INSTALL.md`) now says what an agent does when the installer prints `TC_INSTALL_FAILED permission denied`: stop, send the owner the `TC_INSTALL_FAILED` and `TC_CAUSE` lines word for word, and never run `sudo`, `chmod` or `chown` itself.

Details: TC-3278
