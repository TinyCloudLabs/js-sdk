# Stable release checklist

Applies to every stable cut of the SDK and CLI packages. A stable is published by dispatching the `Release` workflow (`.github/workflows/changesets.yml`) with `confirm=release`; see [versioning.md](./versioning.md) for how the beta and stable paths differ.

## Rules

1. **Main keeps taking reviewed, ready changes.** There is no code freeze and no merge hold before a cut.
2. **The cut date follows the changes landing, not the reverse.** A stable is cut once every must-land change below is merged, reviewed and QA-passed. A date never pulls an unfinished change in, and never keeps a finished one out.
3. A major bump needs a human sign-off (`Major release guard`); agents never write one.

## Stable 1.3.0

Cut date: TBD (set when the short-links work lands).

Must land, in addition to the items already on the cut list:

- **Short share links (TC-1737).** Web composer, CLI and invitation email all produce a short link by default. Existing inline links keep working.
- **Share fixes (21 Oct).** A custom option in the link-expiry picker, with a short warning that a longer expiry keeps the content reachable until it expires or access is revoked. Shares made by agents appear in "Shared by me". "Load more" works.

## Steps

1. Every must-land change above is merged, reviewed and QA-passed.
2. Candidate checks pass on a throwaway account: `tc share publish`, `tc share revoke`, `tc share receive` (expect `SHARE_REVOKED`); `knowledge list|read`; `auth request --preset apps-agent`; the web-sdk root size check; the hosted MCP smoke script.
3. Dispatch `Release` with `confirm=release`. The workflow exits pre mode, versions, publishes to `latest`, re-enters beta mode and creates the GitHub Release.
4. Confirm each published package against npm (`npm view @tinycloud/<pkg> dist-tags`), not the workflow's green check.
5. **Consumers.** Every consumer in the inventory is bumped to the stable version and deployed, or has a dated reason it can't, as part of the stable release. The inventory (TC-1742) lists each consumer's repo and path, the package it takes, the exact version or dist-tag it pins today and how it deploys. The cut is not done until every row is either bumped and deployed, or carries a dated exception with an owner. That includes consumers that pin `@tinycloud/cli@latest` or a beta tag, docs and prompt pages that quote a version, and the hosted MCP.
