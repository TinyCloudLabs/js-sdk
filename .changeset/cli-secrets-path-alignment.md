---
"@tinycloud/cli": minor
---

`tc secrets {get,put,delete,list,doctor}` now targets the literal `secrets` space (matching the secret-manager web app's `SECRETS_SPACE` in `src/lib/tinycloud-manifest.ts`) instead of the active profile's default space, so CLI-issued permission grants line up with secrets stored by the web app. Restores `--space <space>` as a real flag distinct from `--scope <scope>` (previously `--space` was a silent alias for `--scope`); `--space` overrides the permission-grant space. Permission paths remain `vault/secrets/<NAME>` / `vault/secrets/scoped/<scope>/<NAME>` — the `vault/` prefix is the wire-level KV path that `DataVaultService` writes to and that `tinycloud.vault` permissions expand to via `vaultActionExpansion()` in `sdk-core`, not a CLI-only artifact.

Known limitation: `--space` currently only flows through to permission-grant requests; the underlying `node.secrets.{get,put,delete,list}` calls still resolve their own space via the SDK. Lighting `--space` up end-to-end requires SDK work outside this CLI package.
