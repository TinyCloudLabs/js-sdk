# Install, update and remove the core skill

The npm package includes `skills/tc-cli` and every linked reference. Installing the CLI and making its skill discoverable are separate steps. Use Node.js >=22.20.0 for the combined setup (the CLI alone supports >=20).

```bash
npm install --global @tinycloud/cli@0.10.0
npx --yes skills@1.7.0 add https://registry.npmjs.org/@tinycloud/cli/-/cli-0.10.0.tgz --skill tc-cli --global --copy --agent opencode codex claude-code --yes
```

This uses the existing [cross-agent skills installer](https://github.com/vercel-labs/skills). It copies the identified release, including references, into the supported client skill locations without replacing unrelated settings: OpenCode and Codex share `~/.agents/skills`; Claude Code uses `~/.claude/skills`. These are the verified paths for pinned installer 1.7.0 with this command. Select only the agent names in use if desired. Start a new session and ask it to use `tc-cli`; discovery and permission to execute shell commands are controlled separately by the client.

```bash
tc --version
npx --yes skills@1.7.0 list --global
```

The installed `tc-cli/release.json` identifies the skill version, required CLI range and runtime. These should match the intended release; verify before using an app pack. App packs publish their own CLI compatibility and helper version.

To update, read the official release instructions, install the chosen CLI version and rerun `skills add` with that version's immutable npm tarball URL. Repeating the same installation refreshes only the selected skill. Pinning a URL means `skills update` cannot turn that URL into a newer version automatically; change the identified version deliberately. Do not download executable app helpers anew for each question.

```bash
npx --yes skills@1.7.0 remove tc-cli --global --agent opencode codex claude-code --yes
npm uninstall --global @tinycloud/cli
```

The shared `~/.agents/skills/tc-cli` location is used by both OpenCode and Codex, so removing it affects discovery in both clients. Removing the skill/CLI does not delete TinyCloud profiles or revoke data access. App skills are installed and removed by their own names and releases.
