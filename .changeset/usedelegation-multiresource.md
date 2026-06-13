---
"@tinycloud/node-sdk": patch
---

Fix wallet-mode `useDelegation` dropping every resource except the top-level one. A multi-resource delegation (e.g. `[{tinycloud.kv get vault/secrets/X}, {tinycloud.encryption decrypt <networkId>}]`) carries each grant in `delegation.resources[]`, but the flat top-level `path`/`actions` mirror only the first resource. `useDelegation` built the activation sub-delegation's abilities from those flat fields alone, so for multi-resource delegations every other resource was silently dropped — the activated session held only the encryption cap and a subsequent `access.kv.get(...)` failed with `Unauthorized Action: .../tinycloud.kv/get`. Wallet-mode `useDelegation` now builds the activated abilities from the full `resources[]` set (kv/sql/duckdb scoped to the delegation space, encryption network URNs as raw abilities), so one `useDelegation` call grants every resource's capabilities.

Also export the type-only barrel names `WasmKeyProviderConfig` and `NodeUserAuthorizationConfig` as `export type`, so importing node-sdk as raw TypeScript (e.g. via bun) no longer throws `SyntaxError: export 'X' not found`.
