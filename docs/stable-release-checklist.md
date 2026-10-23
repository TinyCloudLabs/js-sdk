# Stable release checklist

Applies to every stable cut of the SDK and CLI packages. A stable is published by dispatching the `Release` workflow (`.github/workflows/changesets.yml`) with `confirm=release`; see [versioning.md](./versioning.md) for how the beta and stable paths differ.

## Rules

1. **`master` keeps taking reviewed, ready changes.** There is no code freeze and no merge hold before a cut.
2. **The cut date follows the changes landing.** A stable is cut once every must-land change below is merged, reviewed and has passed QA. The date does not pull an unfinished change in or keep a finished one out.
3. A major bump needs a human sign-off (`Major release guard`); agents do not write one.

## The next stable cut

The cut date is set when the must-land changes below are merged.

Must land:

- **Short share links (TC-1737).** Web composer, CLI and invitation email all produce a short link by default. Existing inline links keep working.
- **Share fixes.** A custom option in the link-expiry picker, with a short warning that a longer expiry keeps the content reachable until it expires or access is revoked. Shares made by agents appear in "Shared by me". "Load more" works.

## Steps

1. Every must-land change above is merged, reviewed and has passed QA.
2. Candidate checks pass on a throwaway account: `tc share publish`, `tc share revoke`, `tc share receive` (expect `SHARE_REVOKED`); `knowledge list|read`; `auth request --preset apps-agent`; the web-sdk root size check (`bun packages/web-sdk/scripts/check-phase1-replica-dist.ts`); the hosted MCP smoke script (`node scripts/hosted-mcp-smoke.mjs`).
3. Release operator preflight. The operator runs the read-only preflight from the TinyCloud tooling repo (`tinycloud-dev`, not this repository), giving the version each package should publish: `bin/js-sdk-stable-preflight --expect @tinycloud/web-sdk=<version> --expect @tinycloud/cli=<version>`. It computes the versions the cut would produce and exits 0 only when they equal the expected ones and no other package bumps. Exit 1 or 2 means the cut is not dispatched.
4. On preflight exit 0, dispatch `Release` with `confirm=release` (`gh workflow run changesets.yml -f confirm=release`). The workflow exits pre mode, versions, publishes to `latest`, re-enters beta mode and creates the GitHub Release.
5. Confirm each published package against npm (`npm view @tinycloud/<pkg> dist-tags`); the workflow's green check is not the confirmation.
6. **Consumers.** Every consumer in the consumer inventory is bumped to the stable version and deployed as part of the stable release, or has a dated reason it cannot be. The inventory is a list kept with the release ticket; each row gives the consumer's repo and path, the package it takes, the exact version or dist-tag it pins today and how it deploys. The cut is done when every row is bumped and deployed, or carries a dated exception with an owner. Consumers include anything that pins `@tinycloud/cli@latest` or a beta tag, docs and prompt pages that quote a version, and the hosted MCP.
