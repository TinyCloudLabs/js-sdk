# Install, update and remove the core skill

The npm package ships `skills/tc-cli` and every linked reference. Installing the CLI and making its skill discoverable are separate steps. Use Node.js >=22.20.0 for the combined setup (the CLI alone supports >=20).

```bash
npm install --global @tinycloud/cli@beta
TC="$(npm prefix --global)/bin/tc"      # avoids /usr/sbin/tc (iproute2)
VERSION="$("$TC" --version)"
npx --yes skills@1.7.0 add "https://registry.npmjs.org/@tinycloud/cli/-/cli-${VERSION}.tgz" --skill tc-cli --global --copy --agent opencode codex claude-code --yes
```

This uses the [cross-agent skills installer](https://github.com/vercel-labs/skills). It copies the skill for that exact CLI release, including references, into each client's skill directory without touching unrelated settings: OpenCode and Codex share `~/.agents/skills`; Claude Code uses `~/.claude/skills`. Pass only the agent names in use if desired. Start a new session and ask it to use `tc-cli`; discovery and permission to run shell commands are controlled separately by the client.

```bash
"$TC" --version
npx --yes skills@1.7.0 list --global
```

The installed `tc-cli/release.json` names the CLI range the skill describes, the runtime, and the installer. Check it against `tc --version` before relying on newer commands. App skill packs publish their own CLI compatibility.

To update, install the chosen CLI version and rerun `skills add` with that version's tarball URL. Repeating the installation refreshes only this skill. A pinned URL never updates itself; change the version deliberately.

```bash
npx --yes skills@1.7.0 remove tc-cli --global --agent opencode codex claude-code --yes
npm uninstall --global @tinycloud/cli
```

OpenCode and Codex share `~/.agents/skills/tc-cli`, so removing it affects both. Removing the skill or CLI does not delete TinyCloud profiles or revoke data access.
