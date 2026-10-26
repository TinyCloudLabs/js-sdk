---
"@tinycloud/cli": minor
---

Add `tc secrets run NAME... [--map NAME=ENV_VAR] -- <command> [args...]`: it reads the named secrets as `tc secrets get` does and starts the command directly, without a shell, with the values only in its environment. If a secret cannot be read, the command does not start and tc exits as `get` would. tc exits with the command's exit code or signal, forwards SIGINT, SIGTERM, SIGHUP and SIGQUIT to it (as a terminal's foreground job, tc does not pass on SIGINT, SIGQUIT or SIGHUP, which the terminal sends to the command too), and exits 127 or 126 when the command is not found or cannot be executed. tc's own `TC_PRIVATE_KEY` is not passed to the command. The command, and anything it starts, still receives the values and can print or pass them on.

Details: TC-2093
