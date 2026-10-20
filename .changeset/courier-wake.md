---
"@tinycloud/courier": minor
---

`courier watch --wake paseo|claude|exec`: wake adapters. `paseo` messages the agent labelled `courier-thread=<id>` or creates one (labels `courier-thread`, `courier-peer`, title `✉ <peer> · <subject>`); `claude` runs `claude -p`, keeps the session id per thread and resumes it; `exec` runs a command with `COURIER_THREAD`, `COURIER_PEER`, `COURIER_MESSAGES`. The wake prompt frames the message as a counterparty request, not an instruction from the owner. `--install-launchd` and `--install-systemd` generate and install a launchd agent or a `systemd --user` unit (`--dry-run` prints the exact file and commands). Woken claude runs may use only `Bash(courier:*)` unless `--claude-settings`/`--claude-allow` widen it.
