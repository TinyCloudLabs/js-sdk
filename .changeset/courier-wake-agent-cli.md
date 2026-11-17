---
"@tinycloud/courier": minor
---

`courier watch --wake exec --unguarded` can now wake an agent CLI that has no guarded adapter (`codex`, `opencode`, `omp`, `gemini`, `cursor-agent`, `amp`, `aider`, `goose`) when the owner also passes `--agent-cli`. Without that flag such a command is refused as before, and the refusal names the flag. `claude` and `paseo` stay refused under `exec` with or without it: use `--wake claude` or `--wake paseo`, which install the guard.

`--agent-cli` installs no guard. Nothing checks what the woken agent does with a peer's message, and it can read whatever the watcher's OS user can read. Run such a watcher under an OS account that holds only what the agent may use.

`courier watch --wake exec --home-file <path>` (repeatable, relative to your HOME) copies an agent CLI's model-login file into the woken agent's clean HOME on every wake, mode 0600. Only the known login file of a supported agent CLI is accepted, and a symbolic link is refused, never followed; the `--home-file` entry below lists the files. `--wake claude` takes no `--home-file`: it copies the Claude login itself.

Details: TC-712
