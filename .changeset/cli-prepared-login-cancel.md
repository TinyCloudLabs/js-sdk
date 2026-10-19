---
"@tinycloud/cli": patch
---

Cancelling a prepared OpenKey login before approval now takes one path whether it comes from terminal Ctrl-C or a SIGINT/SIGTERM sent to a non-interactive process: the CLI asks OpenKey to cancel the handoff (best effort, two-second timeout), saves nothing and exits 130 `CANCELLED`, as the exit-code table documents. Previously a non-interactive signal never reached OpenKey, and terminal Ctrl-C exited 3.
