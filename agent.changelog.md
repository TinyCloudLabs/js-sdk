# Agent Changelog

Track changes to agent-facing development guidance for the TinyCloud JavaScript SDK. Add a concise
entry when `agent.dev.md` or related agent workflow expectations change.

## 2026-10-19

- Added independent per-invocation diagnostic opt-in; generic telemetry and shared
  client/session markers do not admit unrelated CLI/MCP calls. Kept synchronous
  MCP dispatch/cancellation and explicit first-call coverage uncertainty.
- Fixed shutdown observer lifetime without releasing uncertain writer ownership.
  Preserved subprocess results for migration-marker failures; historical lock and
  marker logs lack enough ownership/exit evidence to establish their original cause.
- Replaced custom archive delivery with a standalone exact-version npm alpha,
  pinned 0.1.6 guidance, offline installation/relocation checks and same-package
  preview image. Normal releases, live routing and participant capture stay untouched.
- Updated pagination and KV/SQL lost-acknowledgment fixtures to use admitted
  tc-apps resources and scoped bindings; retained completeness/no-replay assertions.

## 2026-10-16

- Added the default-off private tc-apps diagnostics contract: independent packaged
  worker/subpath, local-only command inventory, explicit block scope and separate
  selected-detail authority. Preserve loss/unknown outcomes without changing
  business authorization or retries. Release/container and encrypted-volume,
  backup/deletion, client-installation and enablement checks remain separately
  authorized gates; synthetic fixtures are not production acceptance.
- Preserve synchronous MCP cancellation during live stdio policy changes; reject
  duplicate-key JSON imports and retain source-qualified conflict identity and
  original expiry. Record calibrated limits/overhead in the MCP README and run
  installed Node 20/22 worker, native-failure and generated-reproduction acceptance.
- Rollout review hardened global-option refusal, default/aliased state-root
  separation, cancelled MCP correlation and callback/executor classification.
  Source-qualified case expansion and HTTP delivery timing remain explicit;
  these fixes do not authorize selected detail, publication or live capture.
- Pace healthy live-policy probes instead of flooding the bounded diagnostic
  queue with calls and snapshots; keep the policy-transition assertions intact.
- Give the conformance job the operations suite's existing Linux namespace
  preflight; namespace tests remain mandatory in CI, not skipped.
- Await CLI exit sentinels directly in authorization fixtures: Bun 1.3.14's
  rejection matcher fails across nested async-local scope transitions. Keep
  all lost-acknowledgment and authorization assertions without changing runtime code.

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
