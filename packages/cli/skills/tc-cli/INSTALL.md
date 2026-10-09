# Install, update and remove the core skills

The npm package ships `skills/tc-cli`, `skills/courier` (for `tc courier`) and every linked reference. Installing the CLI and making its skill discoverable are separate steps. Use Node.js >=22.20.0 for the combined setup (the CLI alone supports >=20).

```bash
npm install --global @tinycloud/cli@beta
TC="$(npm prefix --global)/bin/tc"      # avoids /usr/sbin/tc (iproute2)
VERSION="$("$TC" --version)"
npx --yes skills@1.7.0 add "https://registry.npmjs.org/@tinycloud/cli/-/cli-${VERSION}.tgz" --skill tc-cli courier --global --copy --agent opencode codex claude-code --yes
```

On Linux, iproute2 installs `/usr/sbin/tc` (traffic control), which can shadow the TinyCloud `tc` on PATH. If the npm global prefix is root-owned, run `npm config set prefix ~/.local` before installing: Ubuntu's default PATH puts `~/.local/bin` before `/usr/sbin`, but `~/.profile` adds it only if the directory existed at login, so start a new login shell after the first install. Run `hash -r` if `tc` already ran in the same shell. Verify with `command -v tc`, or call `"$(npm prefix --global)/bin/tc"` directly.

This uses the [cross-agent skills installer](https://github.com/vercel-labs/skills). It copies the skills for that exact CLI release, including references, into each client's skill directory without touching unrelated settings: OpenCode and Codex share `~/.agents/skills`; Claude Code uses `~/.claude/skills`. Pass only the agent names in use if desired. Start a new session and ask it to use `tc-cli`; discovery and permission to run shell commands are controlled separately by the client.

```bash
"$TC" --version
npx --yes skills@1.7.0 list --global
```

The installed `tc-cli/release.json` names the CLI range the skill describes, the runtime, and the installer. Check it against `tc --version` before relying on newer commands. App skill packs publish their own CLI compatibility.

To update, install the chosen CLI version and rerun `skills add` with that version's tarball URL. Repeating the installation refreshes only this skill. A pinned URL never updates itself; change the version deliberately.

```bash
npx --yes skills@1.7.0 remove tc-cli courier --global --agent opencode codex claude-code --yes
npm uninstall --global @tinycloud/cli
```

OpenCode and Codex share `~/.agents/skills/tc-cli` and `~/.agents/skills/courier`, so removing them affects both. Removing the skill or CLI does not delete TinyCloud profiles or revoke data access.
