---
"@tinycloud/courier": minor
---

`courier watch --wake exec --unguarded` can now wake an agent CLI that has no guarded adapter (`codex`, `opencode`, `omp`, `gemini`, `cursor-agent`, `amp`, `aider`, `goose`) when the owner also passes `--agent-cli`. Without that flag such a command is refused as before, and the refusal names the flag. `claude` and `paseo` stay refused under `exec` with or without it: use `--wake claude` or `--wake paseo`, which install the guard.

`--agent-cli` installs no guard. Nothing checks what the woken agent does with a peer's message, and it can read whatever the watcher's OS user can read. Run such a watcher under an OS account that holds only what the agent may use.

`courier watch --home-file <path>` (repeatable, relative to your HOME, with `--wake exec` or `--wake claude`) copies one file into the woken agent's clean HOME on every wake, mode 0600, for a CLI that keeps its model login in a file. Shell start-up files, tool settings and the credential stores the clean HOME never holds (`.ssh`, `.aws`, `.npmrc`, `.netrc`, `.config/gh`, `.config/git`, Claude and MCP settings) are refused when the watcher starts.

Details: TC-712
