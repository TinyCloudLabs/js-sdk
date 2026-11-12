# Agent Changelog

Track changes to agent-facing development guidance for the TinyCloud JavaScript SDK. Add a concise
entry when `agent.dev.md` or related agent workflow expectations change.

## 2026-11-09

- TC-2393: staged ten-client hosted MCP requirements, existing protocol support,
  source/live header differences and directory/auth review prerequisites.
  No runtime or sign-in behavior changed.

- TC-2416: the hosted personal-records tools use one layout (the `applications`
  space, one folder per app); the older `agent-data` layout, the move tool and the
  `layout` input are removed with no compatibility path. `agent.dev.md` says not to
  reintroduce them.

## 2026-11-07

- Share publishing no longer creates the share key: removed the runtime
  exact Share-key consent route and share-prefix `key.create`; the node records
  the key at policy registration.

## 2026-11-03

- TC-2416: context accepts Health Log and Recipes catalog slugs, bundling
  the known per-app task scopes and explaining read/change inputs in the schema.

- TC-2416: personal-app context optionally bundles the named app and app list;
  documented change/read access and reuse of read-only folder grants.

## 2026-11-02

- Added explicit reusable read-scope consent, cursor-preserving discovery and
  digest-bound complete KV/SQL delivery to private/local MCP and shared
  operations. Native reads retain their existing signed capability ceiling;
  the public ChatGPT surface is unchanged. Handoffs carry locators/provenance,
  not credentials or authority.
- Verified the local hosted HTTP path against the live node using an isolated
  profile copy: the 111,619-byte / 566-segment transcript reconstructed in ten
  pages with the recorded SHA-256; a 130,000-character SQL field reconstructed
  in eleven pages. No cloud records were written and no deployment was made.

## 2026-11-01

- CI: the `conformance` PR job in `.github/workflows/operations-mcp.yml` is split into
  `conformance-core`, `conformance-unit (shard N)` and an aggregate job still named `conformance`
  (the required status check). The CLI/bootstrap/server/MCP OAuth/tests/cli unit loop is sharded by
  file number; every file runs in exactly one shard. New CLI test files are still picked up by
  that glob; focused tests are still listed by hand in `conformance-core`. Shared build steps live
  in `.github/actions/conformance-setup`. Add a new job to the aggregate's `needs:` or it is not
  gated.

- TC-2234: Courier email invitations reuse the Share path. `publishEmailShareV3` now lives in
  `@tinycloud/node-sdk/share-publish` (the CLI imports it). Courier's grant check stays exact:
  the base grant is exactly `AGENT_GRANT`; any `share/` entry is `grant-too-broad`. Per-invitation key authority
  needs a separate approval path (not the standing grant); the OpenKey request and `AGENT_GRANT` are unchanged.

## 2026-10-29

- TC-2192: documented the exact-owner Share-key runtime consent boundary and
  session-binding/native refusal rules. Static manifests remain unchanged.

## 2026-10-26

- MCP personal-app examples and edit/move instructions now omit server-owned
  `by`. Generated write schemas expose the same restriction as runtime
  validation; CLI attribution, nested data fields and read-back values stay unchanged.

## 2026-10-21

- Added the separate five-tool public ChatGPT candidate with distinct OAuth,
  tenant state and approval paths; private integrations retain their broad
  surface. Corrected context/query effects, preserved the derived-query output
  cap, and added reproducible plugin packaging with explicit unfulfilled release
  gates. Default-branch integration and deployment remain owner-approved.

## 2026-10-14

- Hosted personal apps now use canonical operations with CLI-compatible JSON
  bytes, conditional writes and per-op outcomes. Rules are generated from pinned
  published skill bytes; update instructions are in `agent.dev.md`. Hosted logs
  are value-free, and write results must never be cut off by size caps or deadlines.
- The hosted fast copy now checks KV counts and stale markers before SELECT/WITH
  queries, rebuilds by kind, and syncs writes in byte-bounded chunks. A 409 is
  nonretryable `copy_unavailable`; do not route it into another approval. Removed
  the records-only rollout guidance after switching to the full pinned rules.
- TC-1095: the Release workflow queues runs (`cancel-in-progress: false`), pushes the version
  commit before publishing, and publishes only from that commit.
  `.github/scripts/check-npm-release-provenance.mjs` fails the run when npm's copy of a current
  version was published before the commit that set it (add a changeset to bump past it). It also
  stops a beta run while `master` has stable versions npm lacks; re-dispatching the Stable Release
  publishes them from their release commit first.

## 2026-10-11

- TC-834: `tc secrets request` / `wait` / `manage`. CLI error JSON may carry `error.setup`,
  `error.recovery` and `error.progress`; each is allowlisted and validated in
  `packages/cli/src/output/errors.ts` (`safeCliRecovery` dispatches on `action`). Add new CLI fields
  there, never by passing metadata through. New CLI test files must be listed in
  `.github/workflows/operations-mcp.yml`. Docs call the CLI as `"$TC_BIN"` (absolute path) because
  a bare `tc` can be iproute2's `/usr/sbin/tc`.

## 2026-10-05

- Added `packages/replica` (`@tinycloud/replica`, TC-18) and `tc replica`. It must never import
  `@tinycloud/web-sdk` or `@tinycloud/node-sdk`; the CLI bundles it. Its live CLI smoke
  (`packages/cli/test/replica.e2e.test.ts`) needs `TC_REPLICA_E2E_NODE_BIN`, a node serving
  `kv-sync-v1`.

## 2026-10-03

- Agents never bump a major version (TC-615). Changesets are `minor` or `patch`; a maintainer
  approves a major with an empty `approve-major-release: <package>` commit. The `Major release
  guard` PR check and the Release workflow enforce it, and the `major-beta` dispatch that let a
  major beta through without a sign-off is gone.

## 2026-08-14

- Added the Share-first device authorization contract and its cross-repository public CLI smoke.
  Agents must preserve loopback login for local interactive use, keep `--paste` explicit, and prove
  first-time `tc share publish` through the public command before widening service enablement. Relay
  results must remain end-to-end encrypted to the CLI; encrypted-at-rest plaintext handling by the
  relay is not sufficient.

## 2026-05-17

- Added initial agent development notes covering project context, related repositories, build and
  testing expectations, debugging guidance, and additional repo-specific operating context. Tracked
  in TC-1389.
