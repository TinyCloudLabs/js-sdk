---
"@tinycloud/cli": patch
---

`tinycloud courier watch` now carries the two flags added to `@tinycloud/courier`: `--agent-cli`, which with `--wake exec --unguarded` lets the watcher start an agent CLI that has no guarded adapter, and `--home-file <path>`, which copies one file of the owner's HOME into the woken agent's clean HOME. Defaults are unchanged: without `--agent-cli` such a command is still refused, and `claude` and `paseo` are still refused under `exec`.

Details: TC-712
