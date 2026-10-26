---
"@tinycloud/cli": minor
---

Add `tc secrets run NAME... [--map NAME=ENV_VAR] -- <command> [args...]`: it reads the named secrets as `tc secrets get` does and starts the command directly, without a shell, with the values only in its environment. If a secret cannot be read, the command does not start and tc exits as `get` would. tc exits with the command's exit code or signal, passes SIGINT, SIGTERM, SIGHUP and SIGQUIT on to it (except SIGINT, SIGQUIT and SIGHUP when tc runs in a terminal's foreground, since the terminal sends those to the command already), and exits 127 or 126 when the command isn't found or can't be run. tc doesn't pass its own `TC_PRIVATE_KEY` to the command. The command, and anything it starts, still receives the values and can print or pass them on.

Details: TC-2093
