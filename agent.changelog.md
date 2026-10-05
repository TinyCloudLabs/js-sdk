# Agent Changelog

Track changes to agent-facing development guidance for the TinyCloud JavaScript SDK. Add a concise
entry when `agent.dev.md` or related agent workflow expectations change.

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
