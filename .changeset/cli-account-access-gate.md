---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
---

`tc account` commands now exit with `ACCOUNT_ACCESS_REQUIRED` (exit 5) before calling the node when the session lacks the account-space abilities that command invokes, as with a plain OpenKey login. Each command checks its own set (registry reads and writes, `kv/del` for removals, `space/list` and `capabilities/read` on the primary space for the commands that list spaces or delegations). `account delegations revoke` needs no session ability on a local-key profile (it signs with the owner wallet) and is refused with the `tc delegation revoke` command on an OpenKey profile, which cannot carry the raw-CID revoke ability, and the error prints the `tc auth request --grant --cap ...` command that grants exactly those, with a `--paste` variant. `tc auth request --grant` gains `--paste` (OpenKey owner profiles) for browsers that cannot reach the CLI's loopback callback. The account registry sync skip is recorded once per process as a debug event only (`TinyCloud_debug=true`).
