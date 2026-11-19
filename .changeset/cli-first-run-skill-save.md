---
"@tinycloud/cli": minor
"@tinycloud/operations": patch
---

The CLI now explains itself the first time it runs, and can save its own guide for an agent.

- `tinycloud skill save [--agent <client>]` copies the TinyCloud guide that ships with the CLI into the agent's skills folder, with no network and no sign-in. It replaces only a copy TinyCloud saved earlier. `--check` reports whether it is saved and current, and writes nothing.
- The first command in a config folder prints a short description of TinyCloud and its commands on stderr, once.
- After `onboard` finishes, the CLI prints a `Next:` line that offers `skill save`.
- Run by `npx`, the CLI names the `npx` command in its hints and help, not a `tc` or `tinycloud` command that isn't installed.

Details: TC-3278
