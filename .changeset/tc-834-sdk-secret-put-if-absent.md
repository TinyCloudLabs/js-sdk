---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Create-only secret writes, app-derived secret scopes, typed vault write errors, and classified delegation activation failures.

- **New:** `appSecretScope(appId)` derives the canonical secret scope for an app id (`com.listen.app` → `com-listen-app`), with `SECRET_SCOPE_RE`, `MAX_SECRET_SCOPE_LENGTH` (64) and `TC832_RESERVED_SCOPES` exported from every SDK package.
- **New:** `secrets.put(name, value, { ifAbsent: true })` (type `SecretPutOptions`) writes only when the secret does not exist. An existing secret fails with vault error `ALREADY_EXISTS` (KV 412; `meta.status` and the typed KV error as `cause`) and is never overwritten. `DataVaultService.put` accepts `{ ifNoneMatch: "*" }` for network-encrypted vaults; a legacy (key-blob) vault refuses it with `STORAGE_ERROR` before any KV call. The Node and Web secrets wrappers forward the option unchanged.
- **New:** a refused vault write keeps its authorization classification. A refused write is `AUTH_UNAUTHORIZED` only for HTTP 401 (sign-in needed). A 403 is `PERMISSION_DENIED`. Both keep `meta.status` and the typed KV error as `cause`, so `validatedCapabilityOf` still finds the missing capability. Other failures stay `STORAGE_ERROR`, now with `meta` and the KV error chained as the cause.
- **Fix:** KV `get`/`head`/`delete` now honour their timeout and abort signal while reading a 404 body that never finishes, instead of hanging; `createSignedReadUrl` error bodies get the same fix.
- **New:** node-sdk classifies delegation activation failures. `useRuntimeDelegation` reports an unreachable host as an error with `code: "ACTIVATION_TRANSPORT_FAILED"`. `RuntimeDelegationRejection` gains `activation_unavailable` (transport failure, 408, 429, 5xx) and `activation_unauthenticated` (401); every other activation failure stays `activation_rejected`.

**Breaks:**
- Code that matched `STORAGE_ERROR` for a vault or secrets write refused by authorization now receives `AUTH_UNAUTHORIZED` (401) or `PERMISSION_DENIED` (403, or no status).
- `VaultError`/`VaultErrorInput` gain the `ALREADY_EXISTS`, `AUTH_UNAUTHORIZED` and `PERMISSION_DENIED` variants, so exhaustive `switch`es over the vault error code need the new cases.
- Code that enumerates `RuntimeDelegationRejection` / `RUNTIME_DELEGATION_REJECTIONS` sees two new reasons; activation failures that were `activation_rejected` may now be `activation_unavailable` or `activation_unauthenticated`.
