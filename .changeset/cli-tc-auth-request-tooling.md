---
"@tinycloud/cli": minor
"@tinycloud/node-sdk": patch
---

CLI: agent-friendly permission management and cross-space SQL.

- `tc auth request` requests additional runtime permissions via the SDK's
  `grantRuntimePermissions` flow. Accepts `--cap <spec>`, `--permission <file>`,
  or `--manifest <fileOrBase64>`. OpenKey path forwards the requested entries
  through the `/delegate` URL so the consent UI shows what's being asked for.
- `tc auth caps` lists appended runtime delegations and their granted
  capabilities. `--diff <spec>` reports whether the active session covers a
  capability without granting it. `--history` shows the audit log.
- `tc manifest resolve <fileOrUrl>` is a read-only diagnostic that prints the
  effective space URI, capability paths, and SQL database basenames for an
  app manifest.
- `tc sql query|execute|export --space <name|uri>` routes through a
  per-space SQL service so non-primary-space data is reachable. Backed by a
  new `TinyCloudNode.sqlForSpace(spaceId)` helper that mirrors the per-space
  KV factory pattern.
- `tc sql copy --from-space S --from-db D --to-space S2 --to-db D2 [--table T...] [--dry-run]`
  copies rows between databases (optionally across spaces). Refuses self-copy.
- AUTH_UNAUTHORIZED errors emit a copy-pasteable
  `tc auth request --cap "..."` hint derived from the unauthorized resource
  and required action.
- NETWORK_ERROR emits a hint listing alternate profiles and their hosts when
  the active profile's host is unreachable.
- `ProfileConfig.openkeyHost` (or `TC_OPENKEY_HOST` env var) overrides the
  OpenKey base URL per profile, enabling self-hosted or local OpenKey
  deployments for testing accounts. Default unchanged.
- Persists appended runtime delegations alongside the existing session in
  `~/.tinycloud/profiles/<p>/additional-delegations.json` and replays them
  via `useRuntimeDelegation()` on next CLI invocation. Grants logged to
  `auth-grants.jsonl`.

node-sdk: adds `TinyCloudNode.sqlForSpace(spaceId): ISQLService` so callers
that already hold a delegation covering a non-primary space can issue SQL
queries without restoring a fresh session.
