---
"@tinycloud/cli": patch
---

`tinycloud bug-report --attach` now shows the CLI log before sending it. Without a terminal, it saves the log for you to read and sends it only when you run it again with `--confirm <hash>`.

Details: TC-2515
