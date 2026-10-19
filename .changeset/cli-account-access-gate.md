---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
---

`tc account` commands (status, apps, spaces, delegations, index) now exit with `ACCOUNT_ACCESS_REQUIRED` (exit 5) before calling the node when the session holds no account-space permissions, as with a plain OpenKey login. The error prints the `tc auth request --grant --cap ...` command that grants them. The account registry sync skip is now logged once per process at info level.
