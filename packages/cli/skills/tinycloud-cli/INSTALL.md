# Install, update and remove the core skills

agents.tinycloud.xyz serves every TinyCloud skill and pins the CLI version they're tested with. Install, update and remove the CLI and the `tinycloud-cli` and `courier` skills from there.

## Install

Follow https://agents.tinycloud.xyz/cli. It installs the pinned TinyCloud CLI and this skill. Run the CLI as `tinycloud`; on Linux, `tc` is iproute2 traffic control at `/usr/sbin/tc`.

To install this skill, or `courier` for `tinycloud courier`, without the guide:

```bash
curl -fsSL https://agents.tinycloud.xyz/skills/install.js | node - cli --agent claude-code
curl -fsSL https://agents.tinycloud.xyz/skills/install.js | node - courier --agent claude-code
```

Use `--agent codex` or `--agent opencode` for those clients. Skills go into `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<name>` for Claude Code and `~/.agents/skills/<name>` for Codex and OpenCode, which share that folder. The installer checks every file against https://agents.tinycloud.xyz/skills/index.json before it writes anything, and prints `SKILL_INSTALLED <name> <version> <folder>`. Start a new session for the client to discover the skill.

## Check

```bash
tinycloud --version
```

The installed `tinycloud-cli/release.json` names the CLI range the skill describes. Check it against the version before relying on newer commands. App skills publish their own CLI compatibility.

## Update

Run the install again. It installs the versions agents.tinycloud.xyz serves, which change only when the site's pins change; it never follows an npm dist-tag.

## Remove

Delete the skill folders: `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/tinycloud-cli` and `courier` for Claude Code, `~/.agents/skills/tinycloud-cli` and `courier` for Codex and OpenCode. To remove the CLI, run `npm uninstall --global @tinycloud/cli`. Removing the skill or CLI doesn't delete TinyCloud profiles or revoke data access.
