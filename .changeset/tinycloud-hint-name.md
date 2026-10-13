---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
"@tinycloud/courier": patch
---

Hints, examples and completion scripts name the command you ran: `tinycloud …` when invoked as `tinycloud`, `tc …` otherwise. `@tinycloud/operations` exports `CLI_NAME` from `@tinycloud/operations/cli-name` for this. Courier's missing-space hint names the TinyCloud CLI it runs inside (`tinycloud space host agents` under `tinycloud courier`), and `tc` when run as the standalone `courier` bin.
