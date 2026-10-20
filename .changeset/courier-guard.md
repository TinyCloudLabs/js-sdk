---
"@tinycloud/courier": minor
---

`courier guard`: a Claude Code PreToolUse hook that refuses direct merge, deploy, publish, pushes, credential-access and human-only Courier commands. It inspects quoting, wrappers, chains, subshells and nested shells. Approved PR merges use the fixed-argv `courier run-approved <requestId>` broker, which consumes the approval before executing. `courier watch --wake claude` installs guard settings and gives the agent its Courier-only profile snapshot.

The courier grant now includes `me/consumed/` (get, put, list; no del) and approvals are marked used there instead of under `me/state/`, so the courier key cannot un-consume an approval. Existing grants are refused with `grant-incomplete` until `courier init` renews them (one passkey approval). The used check reads from the network every time and fails closed on anything but a key-level 404.

`courier watch --wake paseo` now installs the same guard in `<cwd>/.claude/settings.local.json` (merged with what is there), runs the hook once on a call no approval can unlock and requires a refusal, and wakes nothing otherwise. It only messages Paseo agents labelled `courier-guard=1` that run Claude in the guarded directory, deletes an agent Paseo started elsewhere, and drops `PASEO_AGENT_*`/`PASEO_WORKSPACE_ID` from its environment so `--cwd` is honoured. Non-Claude `--paseo-provider` values are refused. A guarded agent cannot start another agent (`paseo`, `claude`, `codex`, `omp`, … in Bash; `mcp__paseo__*` tools).

`courier watch --wake exec` installs no guard, so it now needs `--exec <cmd> --unguarded` (also with `--install-launchd|--install-systemd`); without the flag the watcher refuses, wakes nothing and names the flag. Every exec wake prints "this wake is not approval-guarded" to stderr and adds it to `COURIER_PROMPT`. `--unguarded` is refused with the `claude`, `paseo` and `none` adapters, which are always guarded or wake nobody. Use `claude` or `paseo` for guarded agent sessions.

The guard's first rule is now fail-closed: a command with run-time expansion or indirection syntax (`{a,b}`, `$…`, backticks, `eval`, `source`, `alias`, here-strings, `xargs`, `find -exec`, `env`/`command`/`sudo` prefixes, `| sh`, …) that also names a gated tool or verb is refused ("expansion syntax with a gated tool name"); plain-word commands are read as before. README, `--help` and the skill document refused commands and the broker invocation.

Woken `claude` and `exec` runs get an environment allowlist and a separate HOME. `--env-pass NAME` adds an explicitly selected variable. The Paseo adapter blanks known credential names and credential-looking watcher variables. Guard settings refuse Read access to credential files.

`courier pause`, `courier resume` and `courier watch` (also as `tc courier …`) and `courier approval` without `--peek` are refused for a woken agent even with an approval, like `courier pair|revoke|init`: the wake budget is the reply loop's breaker, so an agent must not lift its own pause or start a watcher.
