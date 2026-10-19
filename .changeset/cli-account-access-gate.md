---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
---

`tc account` commands now exit with `ACCOUNT_ACCESS_REQUIRED` (exit 5) before calling the node when the session lacks the account-space abilities that command invokes, as with a plain OpenKey login. Each command checks its own set (registry reads and writes, `kv/del` for removals, `space/list` and `capabilities/read` for the commands that list spaces or delegations), and the error prints the `tc auth request --grant --cap ...` command that grants exactly those, with a `--paste` variant. `tc auth request --grant` gains `--paste` (OpenKey owner profiles) for browsers that cannot reach the CLI's loopback callback. The account registry sync skip is recorded once per process as a debug event only (`TinyCloud_debug=true`).
