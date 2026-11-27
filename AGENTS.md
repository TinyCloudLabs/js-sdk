# 
When you are asked a question, assume you are not making any code changes. You are acting from the perspective of a very experienced software architect following best practices. When making code changes, follow the project-specific notes.

packages/web-core:
packages/web-sdk:
examples/web-sdk-example:

<!-- TODO: Set up knip to detect unused exports and dead code across the monorepo -->

## Versioning

Classify compatibility accurately. For stable packages (1.0.0 and later), incompatible public API changes require a `major` changeset with migration notes, or a compatibility path. Use `minor` for compatible features and `patch` for compatible fixes. Follow the documented pre-1.0 policy for 0.x packages. Preparing a changeset does not authorize publishing: actual major version bumps and releases retain maintainer sign-off. Agents do not manufacture `approve-major-release` commits. See `agent.dev.md`.
## Agent clients

No Claude bias in what we build: products must not assume one AI vendor. The CLI, skills, guides and SDKs work the same in every agent client (Claude Code, Codex, Gemini CLI, Cursor and others). Install skills, configs and instructions where each client expects them, following its conventions, never only under Claude paths such as `~/.claude`. Test with more than one client.

## Evidence and delivery

Check the working commit and current upstream before declaring a feature absent or blocked. Saved memory and historical plans are context, not new authorization requirements. Cite the applicable code or active requirement, its scope, and what would resolve a blocker. Honor authorization already given for the task; continue independent authorized work when one step cannot proceed.

Review test updates with the behavior change in the same PR. Explain changed expectations and replacement coverage; do not duplicate obsolete tests to avoid a line-edit gate. Separate storage encryption, key scope, execution trust and outbound authorization. A limitation in one layer does not prohibit unrelated work. Distinguish implemented, merged, released and deployed.
