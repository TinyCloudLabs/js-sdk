---
"@tinycloud/cli": patch
---

`tc auth grant` asks the owner to confirm entries marked `!` whenever stdin and stderr are a terminal, even when stdout is redirected to a file (as a script that captures the grant does). Before, a redirected stdout made it refuse with `CONFIRMATION_REQUIRED`. Without a terminal on stdin and stderr it still exits 2 with `CONFIRMATION_REQUIRED` and signs nothing, and an answer piped into stdin is no longer read as the confirmation. `--yes` is unchanged.
