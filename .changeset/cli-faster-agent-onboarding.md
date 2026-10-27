---
"@tinycloud/cli": minor
---

Faster agent onboarding for personal apps (agents.tinycloud.xyz/apps):

- `tc setup apps --agent <claude-code|codex|opencode|auto|none> [--app <name>]` runs the /apps guide's install steps as one command. It installs exactly this CLI version into `~/.local/share/tc-apps/cli` (`npm install --prefix`, never global, never a tag), installs the `tc-apps` skill that now ships in this package (`skills/tc-apps`, a copy of TinyCloudLabs/prompts `skills/tc-apps` 0.2.1 with the site's `SHA256SUMS`) after checking every file against that list, into the client's skills folder and a private copy, and writes the helper script. With `--app`, it also creates the app's profile and request and starts its sign-in in the background, printing the OpenKey link. If the client's skills folder can't be written, setup still succeeds and prints the command to run later; `--agent none` skips that copy.
- `tc auth login --detach` (browser OpenKey login): prints the approval link as JSON and returns at once, while a detached listener on 127.0.0.1 waits up to 10 minutes for OpenKey's callback. The delegation is verified against the profile's key and saved exactly as in a foreground login. It can't be combined with `--paste`, `--device`, `--keys` or replication.
- `tc auth status --wait <seconds>` waits for that approval: exit 0 once signed in, 8 while still waiting, 3 when no sign-in is pending, or the sign-in's own error (`OPENKEY_PROOF_INVALID`, `AUTH_TIMEOUT`, `LOGIN_LISTENER_EXITED`, …). `auth status --json` also shows a pending or finished detached sign-in as `login`.
- `tc apps init <app> --by <client> [--starter <text>]` starts a tiny app in the tc-apps layout (today `todos`): its catalog records, its discovery entry and an optional starter item, all with create-only writes, using the profile `tinyapp-<app>`. A starter whose done twin exists is not saved again.
- The package publishes with npm provenance (`publishConfig.provenance`).

Details: TC-1559
