# Agent Changelog

Track changes to agent-facing development guidance for the TinyCloud JavaScript SDK. Add a concise
entry when `agent.dev.md` or related agent workflow expectations change.

## 2026-10-29

- TC-2212: clarified that prepared OpenKey logins (`--keys` or replication
  prefixes) retain the localhost callback/manual `--paste` flow and
  `INTERACTIVE_LOGIN_REQUIRED` guard. Normal short-link login is unchanged.

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
