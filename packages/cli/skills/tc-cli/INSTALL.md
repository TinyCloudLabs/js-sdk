# Install, update and remove the core skills

agents.tinycloud.xyz serves every TinyCloud skill and pins the CLI version they're tested with. Install, update and remove the CLI and the `tc-cli` and `courier` skills from there.

## Install

Follow https://agents.tinycloud.xyz/cli. It installs the pinned TinyCloud CLI into `~/.local/share/tinycloud/cli`, makes `tc` run it when nothing else on `PATH` is called `tc`, and installs this skill. Newer CLI releases also ship the same executable as `tinycloud`, an alternative name that takes identical arguments. The skill's first block finds the CLI there; set `TC_BIN` to use another one.

To install this skill, or `courier` for `tc courier`, without the guide:

```bash
curl -fsSL https://agents.tinycloud.xyz/skills/install.js | node - cli --agent claude-code
curl -fsSL https://agents.tinycloud.xyz/skills/install.js | node - courier --agent claude-code
```

Use `--agent codex` or `--agent opencode` for those clients. Skills go into `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<name>` for Claude Code and `~/.agents/skills/<name>` for Codex and OpenCode, which share that folder. The installer checks every file against https://agents.tinycloud.xyz/skills/index.json before it writes anything, and prints `SKILL_INSTALLED <name> <version> <folder>`. Start a new session for the client to discover the skill.

## Check

```bash
TC="${TC_BIN:-$HOME/.local/share/tinycloud/cli/node_modules/.bin/tc}"   # TC_BIN, else where agents.tinycloud.xyz/cli installs it
[ -n "${TC_BIN:-}" ] || [ -x "$TC" ] || ! command -v npm >/dev/null || TC="$(npm prefix --global)/bin/tc"   # else a global npm install
[ -x "$TC" ] || { echo "TC_NOT_FOUND: $TC is not executable; install the CLI from https://agents.tinycloud.xyz/cli or set TC_BIN" >&2; exit 1; }
"$TC" --version
```

The installed `tc-cli/release.json` names the CLI range the skill describes. Check it against the version before relying on newer commands. App skills publish their own CLI compatibility.

## Update

Run the install again. It installs the versions agents.tinycloud.xyz serves, which change only when the site's pins change; it never follows an npm dist-tag.

## Remove

Delete the skill folders: `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/tc-cli` and `courier` for Claude Code, `~/.agents/skills/tc-cli` and `courier` for Codex and OpenCode. To remove the CLI, delete the `tc` link the setup made, if it points into `~/.local/share/tinycloud/cli`, then that folder. Removing the skill or CLI doesn't delete TinyCloud profiles or revoke data access.
