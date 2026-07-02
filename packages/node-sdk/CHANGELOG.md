# @tinycloudlabs/node-sdk

## 2.4.1-beta.0

### Patch Changes

- cbd5dcc: Fix root sharing delegations to infer the delegated service from action URNs instead of always minting KV resources. Long-lived SQL share links now sign `tinycloud.sql/*` capabilities under the SQL service path.

## 2.4.0

### Minor Changes

- 6b554d6: Add shared account APIs for applications and delegations, expose them from the node and web SDK clients, and add the `tc account` CLI command group.
- 75bebb1: Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

  Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.

- 0e8ccc6: Add `TinyCloudNode.hostOwnedSpace(name)` and wire `tc space create`/`tc space host` to it.

  Hosting an owned space (e.g. `applications`) by name now registers it on the server via the host-SIWE delegation flow, so subsequent KV/SQL writes to that space succeed instead of returning `404 - Space not found`. Unlike the internal `ensureOwnedSpaceHosted`, this always submits the host delegation rather than inferring hosting from session activation — a space the current session has never referenced is reported neither `activated` nor `skipped`, which previously caused the host to be silently skipped. The host SIWE is idempotent server-side, so re-hosting an existing space is a safe no-op.

  The `tc space create <name>` command (which previously POSTed the unsupported `tinycloud.space/create` action and failed with `401 Unauthorized`) now hosts the caller's owned space; `tc space host <name>` is added as an alias.

- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

- eb44380: `ensureOwnedSpaceHosted` now consults the account spaces registry before hosting

  Previously `TinyCloudNode.ensureOwnedSpaceHosted(name)` always delegated to
  `hostOwnedSpace`, which unconditionally submits the host-SIWE delegation. Owners
  who already had the space hosted (e.g. a git-haiku owner re-running TinyCloud
  Secrets setup) were therefore prompted to "host" their `secrets` space on every
  run.

  `ensureOwnedSpaceHosted` now resolves the owned space id and first checks the
  account spaces registry: the fast SQLite index (`account.index.spaces.list()`)
  as a best-effort short-circuit, falling back to the canonical, recap-readable KV
  record `account/spaces/{space_id}` (`account.spaces.get`). If the space is
  already registered/hosted it returns the id WITHOUT submitting a host delegation
  (no redundant signature). Only when the space is absent — or the registry check
  fails in any way (e.g. a cold index reporting `no such table: spaces`) — does it
  fall through to `hostOwnedSpace`. After hosting it durably write-through
  registers the space so subsequent calls short-circuit on the registry.

  `hostOwnedSpace` (always-host) is unchanged for callers that explicitly want it.
  The KV path is used rather than `syncAccessible()` because a manifest/recap
  session can read `account/spaces/` under the recap but does not hold
  `tinycloud.space/list`.

- 27f97d8: Add a public `ensureOwnedSpaceHosted(name)` method to `TinyCloudNode` and `TinyCloudWeb` for hosting an owner's owned space (e.g. `"secrets"`) from a session created with a manifest / capabilityRequest.

  A full-authority sign-in auto-hosts the owner's `secrets` space, but a session created with a manifest / capabilityRequest does not. Such a session could hold valid `tinycloud.kv/*` capabilities for the owned `secrets` space yet still fail its first scoped `secrets.put(...)` with `404 Space not found`, because the space was never registered on the node. `ensureOwnedSpaceHosted(name)` resolves the name to the owner's owned-space URI and hosts it via the host-SIWE delegation flow (one signature, idempotent server-side), so subsequent scoped secret writes succeed.

- aa050d1: Resolve and rehydrate `tinycloudHosts` on restored sessions.

  A restored session never resolved its TinyCloud hosts: the restore path
  rehydrated the delegation/address/chainId but never set the hosts, and the
  hosts a session was created with weren't persisted. The first kv/secrets/
  space/encryption call on a restored session therefore threw "TinyCloud
  hosts have not been resolved. Call signIn() first." (notably when
  `signIn()` short-circuited to a restored session).

  Fix (three parts):
  - Persist the hosts: `PersistedSessionData` gains an optional
    `tinycloudHosts` field (back-compat — old persisted sessions still
    validate), and both sign-in save paths write the just-resolved hosts.
  - Rehydrate on restore: `TinyCloudNode.restoreSession` accepts the
    persisted `tinycloudHosts`, adopts them for the service context and the
    auth layer (`setRestoredTinyCloudSession`), and the web SDK threads the
    field through `restoreDataFromPersisted`.
  - Lazy fallback: sessions persisted before this field re-resolve their
    hosts lazily (registry → `node.tinycloud.xyz` fallback) on the first
    host-needing call, exactly like a fresh sign-in. Resolution failures
    surface rather than being masked.

  A restored session now targets the same node as the original sign-in, so
  apps no longer need to pass `tinycloudHosts` explicitly or call
  `clearPersistedSession()` before sign-in.

### Patch Changes

- 0d397a8: Treat the account SQLite index as a materialized cache for user-facing account reads. Account application, space, and delegation list calls can now prefer the index while falling back to canonical account data when index tables are missing or empty, and account writes no longer fail when a best-effort index update fails.
- 895804a: Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.
- 6622043: Expose `account.index.ensure()` and `tc account index ensure` for lightweight account SQLite schema bootstrap, and start schema bootstrap with background account registry sync.
- 79dd26c: Add the canonical account bootstrap manifest package, shared bootstrap schemas/allowlist, OpenKey callback signing strategy, and first-sign-in SDK bootstrap orchestration for enshrined spaces.
- 08e292d: Thread `invokeAny` into `DelegatedAccess` so delegated sessions can form multi-action SQL invocations. `DelegatedAccess` previously built its `ServiceContext` with only the single-action `invoke`, so any SQL operation needing more than one action in a single `/invoke` — e.g. the migration runner's `ensureMigrationsTable`, which bundles a `CREATE TABLE` schema action with the tracking-row `write` — threw `SQL operation requires multiple permissions ... but this SDK runtime does not support multi-resource invocations`. `DelegatedAccess` now accepts an optional `invokeAny`, and both `TinyCloudNode` construction sites pass `wasmBindings.invokeAny`, mirroring how the top-level node session already wires it.
- 7c5fe21: Automatically ensure owner-owned encryption networks exist during manifest-driven sign-in. When a requested `tinycloud.encryption/decrypt` permission targets the signed-in user's network ID, the SDK adds a separate scoped `tinycloud.encryption/network.create` sign-in grant and `signIn()` creates the network if the node reports it missing.
- 8e8f7e8: Fix runtime permission grants silently failing to match across EIP-155 address-case differences.

  `TinyCloudNode.operationCovers` compared a runtime grant's `spaceId` against the requested operation's `spaceId` byte-for-byte. Stored runtime delegations (e.g. from `tc auth request --grant`, replayed on every node create) keep the EIP-55 **checksummed** address, while a space URI built by the CLI is **lowercased** — so a valid granted capability never matched and the invocation fell back to the base session, surfacing as a spurious `401 AUTH_UNAUTHORIZED` ("active session missing capability") even though `tc auth caps` showed the cap.

  Ethereum addresses are case-insensitive; space comparison now lowercases ONLY the `eip155:<chain>:0x<addr>` address segment before comparing, leaving the case-sensitive space NAME byte-exact. This is the runtime-grant analogue of the CLI-layer `OPENKEY_SCOPE_MISMATCH` fix (`normalizeSpaceForCompare`).

- fa4a7c7: Add regression coverage for SQL migration batches that require both `tinycloud.sql/ddl` and `tinycloud.sql/write`, including the legacy-session runtime permission repair path used by TinyCloud Secrets.
- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.
- b6c3fd8: Fix wallet-mode `useDelegation` dropping every resource except the top-level one. A multi-resource delegation (e.g. `[{tinycloud.kv get vault/secrets/X}, {tinycloud.encryption decrypt <networkId>}]`) carries each grant in `delegation.resources[]`, but the flat top-level `path`/`actions` mirror only the first resource. `useDelegation` built the activation sub-delegation's abilities from those flat fields alone, so for multi-resource delegations every other resource was silently dropped — the activated session held only the encryption cap and a subsequent `access.kv.get(...)` failed with `Unauthorized Action: .../tinycloud.kv/get`. Wallet-mode `useDelegation` now builds the activated abilities from the full `resources[]` set (kv/sql/duckdb scoped to the delegation space, encryption network URNs as raw abilities), so one `useDelegation` call grants every resource's capabilities.

  Also export the type-only barrel names `WasmKeyProviderConfig` and `NodeUserAuthorizationConfig` as `export type`, so importing node-sdk as raw TypeScript (e.g. via bun) no longer throws `SyntaxError: export 'X' not found`.

- Updated dependencies [6b554d6]
- Updated dependencies [0d397a8]
- Updated dependencies [895804a]
- Updated dependencies [6622043]
- Updated dependencies [75bebb1]
- Updated dependencies [79dd26c]
- Updated dependencies [eb44380]
- Updated dependencies [7603d1f]
- Updated dependencies [27f97d8]
- Updated dependencies [aa050d1]
- Updated dependencies [d4a0a69]
- Updated dependencies [a22a7f0]
- Updated dependencies [42f1235]
  - @tinycloud/sdk-core@2.4.0

## 2.4.0-beta.19

### Patch Changes

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.
- Updated dependencies [42f1235]
  - @tinycloud/sdk-core@2.4.0-beta.19

## 2.4.0-beta.18

### Patch Changes

- 08e292d: Thread `invokeAny` into `DelegatedAccess` so delegated sessions can form multi-action SQL invocations. `DelegatedAccess` previously built its `ServiceContext` with only the single-action `invoke`, so any SQL operation needing more than one action in a single `/invoke` — e.g. the migration runner's `ensureMigrationsTable`, which bundles a `CREATE TABLE` schema action with the tracking-row `write` — threw `SQL operation requires multiple permissions ... but this SDK runtime does not support multi-resource invocations`. `DelegatedAccess` now accepts an optional `invokeAny`, and both `TinyCloudNode` construction sites pass `wasmBindings.invokeAny`, mirroring how the top-level node session already wires it.

## 2.4.0-beta.17

### Patch Changes

- 6622043: Expose `account.index.ensure()` and `tc account index ensure` for lightweight account SQLite schema bootstrap, and start schema bootstrap with background account registry sync.
- Updated dependencies [6622043]
  - @tinycloud/sdk-core@2.4.0-beta.17

## 2.4.0-beta.16

### Minor Changes

- eb44380: `ensureOwnedSpaceHosted` now consults the account spaces registry before hosting

  Previously `TinyCloudNode.ensureOwnedSpaceHosted(name)` always delegated to
  `hostOwnedSpace`, which unconditionally submits the host-SIWE delegation. Owners
  who already had the space hosted (e.g. a git-haiku owner re-running TinyCloud
  Secrets setup) were therefore prompted to "host" their `secrets` space on every
  run.

  `ensureOwnedSpaceHosted` now resolves the owned space id and first checks the
  account spaces registry: the fast SQLite index (`account.index.spaces.list()`)
  as a best-effort short-circuit, falling back to the canonical, recap-readable KV
  record `account/spaces/{space_id}` (`account.spaces.get`). If the space is
  already registered/hosted it returns the id WITHOUT submitting a host delegation
  (no redundant signature). Only when the space is absent — or the registry check
  fails in any way (e.g. a cold index reporting `no such table: spaces`) — does it
  fall through to `hostOwnedSpace`. After hosting it durably write-through
  registers the space so subsequent calls short-circuit on the registry.

  `hostOwnedSpace` (always-host) is unchanged for callers that explicitly want it.
  The KV path is used rather than `syncAccessible()` because a manifest/recap
  session can read `account/spaces/` under the recap but does not hold
  `tinycloud.space/list`.

### Patch Changes

- Updated dependencies [eb44380]
  - @tinycloud/sdk-core@2.4.0-beta.16

## 2.4.0-beta.15

### Patch Changes

- @tinycloud/sdk-core@2.4.0-beta.15

## 2.4.0-beta.14

### Patch Changes

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- Updated dependencies [a22a7f0]
  - @tinycloud/sdk-core@2.4.0-beta.14

## 2.4.0-beta.13

### Patch Changes

- Updated dependencies [7603d1f]
  - @tinycloud/sdk-core@2.4.0-beta.13

## 2.4.0-beta.12

### Patch Changes

- fa4a7c7: Add regression coverage for SQL migration batches that require both `tinycloud.sql/ddl` and `tinycloud.sql/write`, including the legacy-session runtime permission repair path used by TinyCloud Secrets.
  - @tinycloud/sdk-core@2.4.0-beta.12

## 2.4.0-beta.11

### Minor Changes

- aa050d1: Resolve and rehydrate `tinycloudHosts` on restored sessions.

  A restored session never resolved its TinyCloud hosts: the restore path
  rehydrated the delegation/address/chainId but never set the hosts, and the
  hosts a session was created with weren't persisted. The first kv/secrets/
  space/encryption call on a restored session therefore threw "TinyCloud
  hosts have not been resolved. Call signIn() first." (notably when
  `signIn()` short-circuited to a restored session).

  Fix (three parts):
  - Persist the hosts: `PersistedSessionData` gains an optional
    `tinycloudHosts` field (back-compat — old persisted sessions still
    validate), and both sign-in save paths write the just-resolved hosts.
  - Rehydrate on restore: `TinyCloudNode.restoreSession` accepts the
    persisted `tinycloudHosts`, adopts them for the service context and the
    auth layer (`setRestoredTinyCloudSession`), and the web SDK threads the
    field through `restoreDataFromPersisted`.
  - Lazy fallback: sessions persisted before this field re-resolve their
    hosts lazily (registry → `node.tinycloud.xyz` fallback) on the first
    host-needing call, exactly like a fresh sign-in. Resolution failures
    surface rather than being masked.

  A restored session now targets the same node as the original sign-in, so
  apps no longer need to pass `tinycloudHosts` explicitly or call
  `clearPersistedSession()` before sign-in.

### Patch Changes

- Updated dependencies [aa050d1]
  - @tinycloud/sdk-core@2.4.0-beta.11

## 2.4.0-beta.10

### Minor Changes

- 27f97d8: Add a public `ensureOwnedSpaceHosted(name)` method to `TinyCloudNode` and `TinyCloudWeb` for hosting an owner's owned space (e.g. `"secrets"`) from a session created with a manifest / capabilityRequest.

  A full-authority sign-in auto-hosts the owner's `secrets` space, but a session created with a manifest / capabilityRequest does not. Such a session could hold valid `tinycloud.kv/*` capabilities for the owned `secrets` space yet still fail its first scoped `secrets.put(...)` with `404 Space not found`, because the space was never registered on the node. `ensureOwnedSpaceHosted(name)` resolves the name to the owner's owned-space URI and hosts it via the host-SIWE delegation flow (one signature, idempotent server-side), so subsequent scoped secret writes succeed.

### Patch Changes

- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

- Updated dependencies [27f97d8]
- Updated dependencies [d4a0a69]
  - @tinycloud/sdk-core@2.4.0-beta.10

## 2.4.0-beta.9

### Patch Changes

- 0d397a8: Treat the account SQLite index as a materialized cache for user-facing account reads. Account application, space, and delegation list calls can now prefer the index while falling back to canonical account data when index tables are missing or empty, and account writes no longer fail when a best-effort index update fails.
- Updated dependencies [0d397a8]
  - @tinycloud/sdk-core@2.4.0-beta.9

## 2.4.0-beta.8

### Patch Changes

- 895804a: Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.
- Updated dependencies [895804a]
  - @tinycloud/sdk-core@2.4.0-beta.8

## 2.4.0-beta.7

### Minor Changes

- 75bebb1: Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

  Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.

### Patch Changes

- Updated dependencies [75bebb1]
  - @tinycloud/sdk-core@2.4.0-beta.7

## 2.4.0-beta.6

### Minor Changes

- 6b554d6: Add shared account APIs for applications and delegations, expose them from the node and web SDK clients, and add the `tc account` CLI command group.

### Patch Changes

- Updated dependencies [6b554d6]
  - @tinycloud/sdk-core@2.4.0-beta.6

## 2.4.0-beta.5

### Patch Changes

- 7c5fe21: Automatically ensure owner-owned encryption networks exist during manifest-driven sign-in. When a requested `tinycloud.encryption/decrypt` permission targets the signed-in user's network ID, the SDK adds a separate scoped `tinycloud.encryption/network.create` sign-in grant and `signIn()` creates the network if the node reports it missing.

## 2.4.0-beta.3

### Patch Changes

- 8e8f7e8: Fix runtime permission grants silently failing to match across EIP-155 address-case differences.

  `TinyCloudNode.operationCovers` compared a runtime grant's `spaceId` against the requested operation's `spaceId` byte-for-byte. Stored runtime delegations (e.g. from `tc auth request --grant`, replayed on every node create) keep the EIP-55 **checksummed** address, while a space URI built by the CLI is **lowercased** — so a valid granted capability never matched and the invocation fell back to the base session, surfacing as a spurious `401 AUTH_UNAUTHORIZED` ("active session missing capability") even though `tc auth caps` showed the cap.

  Ethereum addresses are case-insensitive; space comparison now lowercases ONLY the `eip155:<chain>:0x<addr>` address segment before comparing, leaving the case-sensitive space NAME byte-exact. This is the runtime-grant analogue of the CLI-layer `OPENKEY_SCOPE_MISMATCH` fix (`normalizeSpaceForCompare`).

## 2.4.0-beta.2

### Minor Changes

- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

### Patch Changes

- @tinycloud/sdk-core@2.4.0-beta.2

## 2.4.0-beta.1

### Minor Changes

- 0e8ccc6: Add `TinyCloudNode.hostOwnedSpace(name)` and wire `tc space create`/`tc space host` to it.

  Hosting an owned space (e.g. `applications`) by name now registers it on the server via the host-SIWE delegation flow, so subsequent KV/SQL writes to that space succeed instead of returning `404 - Space not found`. Unlike the internal `ensureOwnedSpaceHosted`, this always submits the host delegation rather than inferring hosting from session activation — a space the current session has never referenced is reported neither `activated` nor `skipped`, which previously caused the host to be silently skipped. The host SIWE is idempotent server-side, so re-hosting an existing space is a safe no-op.

  The `tc space create <name>` command (which previously POSTed the unsupported `tinycloud.space/create` action and failed with `401 Unauthorized`) now hosts the caller's owned space; `tc space host <name>` is added as an alias.

### Patch Changes

- @tinycloud/sdk-core@2.4.0-beta.1

## 2.3.1-beta.0

### Patch Changes

- b6c3fd8: Fix wallet-mode `useDelegation` dropping every resource except the top-level one. A multi-resource delegation (e.g. `[{tinycloud.kv get vault/secrets/X}, {tinycloud.encryption decrypt <networkId>}]`) carries each grant in `delegation.resources[]`, but the flat top-level `path`/`actions` mirror only the first resource. `useDelegation` built the activation sub-delegation's abilities from those flat fields alone, so for multi-resource delegations every other resource was silently dropped — the activated session held only the encryption cap and a subsequent `access.kv.get(...)` failed with `Unauthorized Action: .../tinycloud.kv/get`. Wallet-mode `useDelegation` now builds the activated abilities from the full `resources[]` set (kv/sql/duckdb scoped to the delegation space, encryption network URNs as raw abilities), so one `useDelegation` call grants every resource's capabilities.

  Also export the type-only barrel names `WasmKeyProviderConfig` and `NodeUserAuthorizationConfig` as `export type`, so importing node-sdk as raw TypeScript (e.g. via bun) no longer throws `SyntaxError: export 'X' not found`.

## 2.3.0

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.
- 90bdc18: Add canonical encryption network ID helpers so apps can compare network-scoped capabilities across equivalent owner DID address casing.
- 9550c18: Add CLI auth artifact handoff flows for owner/delegate workflows.

  `tc auth request` now emits and stores a `tinycloud.auth.request` artifact by
  default, with `--grant` preserving the immediate grant behavior. Profiles now
  track canonical posture/operator metadata so a local key, OpenKey owner, or
  delegate session can be represented explicitly.

  New commands:
  - `tc auth grant <request>` consumes a request artifact as an owner profile and
    emits a `tinycloud.auth.delegation` artifact to stdout. Local-key owner
    grants can use `--yes` for non-interactive approval.
  - `tc auth import <artifact>` installs delegation artifacts and preserves their
    originating request id.
  - `tc auth retry <requestId|--last> --exec` reruns the captured command once the
    requested permissions are covered.

  Local-key CLI profiles now persist and restore their TinyCloud session key
  identity so request artifacts target the same session key that later imports the
  delegation. `@tinycloud/node-sdk` now accepts runtime delegations targeted at the
  fragmentless form of the current session DID (`did:key:...`) as equivalent to
  the session verification method DID URL (`did:key:...#...`).

- ddab8fa: Add `TinyCloudNode.kvForSpace(spaceId)` and a `--space` option on `tc kv get/list/head`, mirroring the existing `sqlForSpace` / `tc sql --space`. This lets KV reads target a non-primary space — e.g. reading a manifest app's data kept under the owner's `applications` space (such as Listen's transcripts at `applications/kv/<app-id>/transcript/<id>`) when the session already holds a covering delegation.
- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.
- Updated dependencies [a92819d]
- Updated dependencies [90bdc18]
- Updated dependencies [f615a19]
- Updated dependencies [fb96a1e]
- Updated dependencies [d606baf]
- Updated dependencies [c7676d6]
- Updated dependencies [f11e468]
  - @tinycloud/sdk-core@2.3.0
  - @tinycloud/node-sdk-wasm@1.7.4

## 2.3.0-beta.8

### Patch Changes

- ddab8fa: Add `TinyCloudNode.kvForSpace(spaceId)` and a `--space` option on `tc kv get/list/head`, mirroring the existing `sqlForSpace` / `tc sql --space`. This lets KV reads target a non-primary space — e.g. reading a manifest app's data kept under the owner's `applications` space (such as Listen's transcripts at `applications/kv/<app-id>/transcript/<id>`) when the session already holds a covering delegation.
- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.
- Updated dependencies [f11e468]
  - @tinycloud/sdk-core@2.3.0-beta.8

## 2.3.0-beta.7

### Patch Changes

- @tinycloud/sdk-core@2.3.0-beta.7

## 2.3.0-beta.6

### Minor Changes

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

### Patch Changes

- Updated dependencies [c7676d6]
  - @tinycloud/sdk-core@2.3.0-beta.6

## 2.3.0-beta.5

### Patch Changes

- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- Updated dependencies [d606baf]
  - @tinycloud/node-sdk-wasm@1.7.4-beta.1
  - @tinycloud/sdk-core@2.3.0-beta.5

## 2.3.0-beta.4

### Patch Changes

- 90bdc18: Add canonical encryption network ID helpers so apps can compare network-scoped capabilities across equivalent owner DID address casing.
- Updated dependencies [90bdc18]
  - @tinycloud/sdk-core@2.3.0-beta.4

## 2.3.0-beta.3

### Patch Changes

- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.
- Updated dependencies [a92819d]
  - @tinycloud/sdk-core@2.3.0-beta.3

## 2.3.0-beta.2

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

### Patch Changes

- Updated dependencies [fb96a1e]
  - @tinycloud/sdk-core@2.3.0-beta.2

## 2.2.1-beta.1

### Patch Changes

- 9550c18: Add CLI auth artifact handoff flows for owner/delegate workflows.

  `tc auth request` now emits and stores a `tinycloud.auth.request` artifact by
  default, with `--grant` preserving the immediate grant behavior. Profiles now
  track canonical posture/operator metadata so a local key, OpenKey owner, or
  delegate session can be represented explicitly.

  New commands:
  - `tc auth grant <request>` consumes a request artifact as an owner profile and
    emits a `tinycloud.auth.delegation` artifact to stdout. Local-key owner
    grants can use `--yes` for non-interactive approval.
  - `tc auth import <artifact>` installs delegation artifacts and preserves their
    originating request id.
  - `tc auth retry <requestId|--last> --exec` reruns the captured command once the
    requested permissions are covered.

  Local-key CLI profiles now persist and restore their TinyCloud session key
  identity so request artifacts target the same session key that later imports the
  delegation. `@tinycloud/node-sdk` now accepts runtime delegations targeted at the
  fragmentless form of the current session DID (`did:key:...`) as equivalent to
  the session verification method DID URL (`did:key:...#...`).

## 2.2.1-beta.0

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- Updated dependencies [f615a19]
  - @tinycloud/node-sdk-wasm@1.7.4-beta.0
  - @tinycloud/sdk-core@2.2.1-beta.0

## 2.2.0

### Minor Changes

- 0401ff8: Add default TinyCloud host discovery and run it from sign-in when no explicit host is configured.
- 9ff4b34: Introduce `EXPIRY` tiers as the single source of truth for default
  delegation lifetimes. Pick a tier, not a number, when adding a new
  delegation surface.

  The delegation tiers and signed URL TTL, exported from `@tinycloud/sdk-core`:
  - `EXPIRY.EPHEMERAL_MS` (1h) — auto-refreshable, never user-visible.
  - `EXPIRY.SIGNED_READ_URL_MS` (5m) — short-lived bearer KV read URLs.
  - `EXPIRY.SESSION_MS` (7d) — sign-in sessions and runtime grants
    (capped by session anyway).
  - `EXPIRY.SHARE_MS` (7d) — share links and ad-hoc third-party
    delegations.
  - `EXPIRY.APP_MS` (30d) — manifest-declared installs.
  - `EXPIRY.MAX_MS` (10y) — caller-supplied upper bound.

  Behavior changes:
  - **`SharingService` share-link default: 24h → 7d.** Same direction as
    the runtime-grant default that already shipped at 7d. Callers passing
    explicit expiry are unaffected.
  - **`DelegationManager.create()` default: 24h → 7d** when the caller
    omits `expiry`.
  - **`SpaceService` server-response fallback: 24h → 7d** when the
    server's delegation response lacks an `expiry` field.
  - **`NodeUserAuthorization.sessionExpirationMs` default: 1h → 7d.**
    Fixes a silent inconsistency where direct `NodeUserAuthorization`
    consumers got 1h while `TinyCloudNode` users got 7d.
  - **`TinyCloudNode` public-space sub-delegation: 1h** (unchanged value,
    re-tagged as `EPHEMERAL` to make the intent legible — these are
    re-derived transparently on every public-space touch).

  Sites unchanged in value but re-pointed at tiered constants:
  - `TinyCloudNode.DEFAULT_SESSION_EXPIRATION_MS` → `EXPIRY.SESSION_MS`
  - `delegateToHelpers.DEFAULT_DELEGATION_EXPIRY_MS` → `EXPIRY.SESSION_MS`
  - `manifest.DEFAULT_EXPIRY` (`"30d"`) — still ms-format string for
    parser compatibility, comment now points at `EXPIRY.APP_MS`.

- 9ff4b34: Default delegation lifetime bumped to 7 days; default session lifetime
  bumped to 7 days; CLI gains `tc auth request --expiry`.

  Why: 1-hour grants forced agent workflows to re-prompt the user for caps
  they had already approved on every CLI invocation past the first hour.
  The session itself defaulted to 1 hour too, so even an explicit
  `--expiry 30d` couldn't outlive its parent. Both defaults moved to 7
  days so the common agent loop runs unattended for a week.
  - `delegateToHelpers.resolveExpiryMs(undefined)` now returns
    `DEFAULT_DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000`.
  - `TinyCloudNodeConfig.sessionExpirationMs` default is now
    `DEFAULT_SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000`. Existing
    callers passing an explicit value are unaffected. Wallet-mode SIWE
    sessions cap at 1 hour by protocol — that limit is independent of
    this default.
  - `tc auth request --expiry <duration>` accepts a ms-format string
    (`"7d"`, `"30m"`) or raw millisecond integer. Forwarded to
    `node.grantRuntimePermissions(permissions, { expiry })` for the
    local-key path and encoded into the OpenKey `/delegate?expiry=...`
    URL parameter for the OpenKey path. OpenKey-side support landed
    separately in TinyCloudLabs/openkey.

- 6561589: Add manifest v1 composition helpers, per-space capability requests, materialized manifest delegations, and the default account-space application registry grant.
- 010ee0f: Fix `restoreSession` so runtime-permission-grant operations work after
  session restore (notably the OpenKey-backed CLI path).

  `TinyCloudNode.restoreSession` populated `_serviceContext.session` (the
  `ServiceSession` used by service invokers) but never set
  `auth.tinyCloudSession` (the richer `TinyCloudSession` that surfaces the
  SIWE recap, address, chain, etc.). Methods that read from the latter —
  `hasRuntimePermissions`, `getRuntimePermissionDelegations`,
  `useRuntimeDelegation`, `grantRuntimePermissions` — therefore threw
  `SessionExpiredError(new Date(0))` immediately after every restore.

  Symptoms:
  - `tc auth request --cap …` fails with `Session expired at 1970-01-01T00:00:00.000Z`
  - Persisted runtime delegations replayed via `useRuntimeDelegation` are
    rejected, so `tc auth caps` reports `granted: []` even when
    `additional-delegations.json` has live entries.

  Changes:
  - `restoreSession` now accepts optional `siwe` and `signature` fields.
  - When `siwe` + `address` + `chainId` are provided, a full
    `TinyCloudSession` is rehydrated. In wallet mode it lands on
    `auth.tinyCloudSession` via the new
    `NodeUserAuthorization.setRestoredTinyCloudSession`. In session-only
    mode (no auth layer — typical for OpenKey-restored CLIs) it lands on
    a new `TinyCloudNode._restoredTcSession` field.
  - A new private `currentTinyCloudSession()` helper resolves the active
    session from either surface. The four runtime-permission readers
    (`hasRuntimePermissions`, `getRuntimePermissionDelegations`,
    `useRuntimeDelegation`, `grantRuntimePermissions`) now consult it.

  CLI side (`@tinycloud/cli`): `replayAdditionalDelegations` exposes a
  `TC_DEBUG_REPLAY=1` env switch that prints which stored delegations
  fail to install and why. Useful for diagnosing future restore-related
  issues.

  Backwards compatible: `restoreSession`'s new parameters are optional;
  old callers continue to work, they just don't get runtime-grant
  support until they pass `siwe`. The CLI was already passing `siwe` —
  the SDK was just dropping it.

- 8367cef: Store approved runtime permissions as narrow portable delegations and route matching invocations through them instead of expanding the app manifest and re-signing the whole session. `delegateTo()` can now derive from an installed runtime delegation, web permission requests return any created runtime delegations, and the secrets wrapper can use the SDK's connected signer when unlocking the backing vault.
- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.
- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.
- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

- 78ef7eb: Add `tinycloud.vault` as an SDK permission shorthand that expands to the backing KV permissions used by encrypted vault operations, including runtime permission escalation.

### Patch Changes

- 9ab4644: Check whether the manifest account registry space already exists before hosting it during sign-in, avoiding repeated account-space host prompts.
- 9ff4b34: CLI: agent-friendly permission management and cross-space SQL.
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

- 04a0d5c: Expose `DelegatedAccess.restorable` — a read-only projection of the activated session handles (`delegationHeader`, `delegationCid`, `spaceId`, `jwk`, `verificationMethod`, `address`, `chainId`) in the exact shape `TinyCloudNode.restoreSession(...)` consumes. Enables persisting a `useDelegation` activation across processes or restarts (e.g. agent runtimes that want vanilla `@tinycloud/cli` to operate against a delegated space). Note: in wallet mode the header/cid are minted against the activator's server-side session and expire with it (~1h), so callers must periodically re-run `useDelegation` + `restoreSession`.
- b9a24b5: Add implicit space-level `tinycloud.capabilities/read` grants for every space touched by a manifest request.
- Updated dependencies [0401ff8]
- Updated dependencies [0e049d7]
- Updated dependencies [9dc2e8c]
- Updated dependencies [9ff4b34]
- Updated dependencies [2305a65]
- Updated dependencies [b9a24b5]
- Updated dependencies [de4d662]
- Updated dependencies [6561589]
- Updated dependencies [35212bb]
- Updated dependencies [46f126a]
- Updated dependencies [f43143d]
- Updated dependencies [78ef7eb]
  - @tinycloud/sdk-core@2.2.0
  - @tinycloud/node-sdk-wasm@1.7.3

## 2.2.0-beta.13

### Patch Changes

- @tinycloud/sdk-core@2.2.0-beta.13

## 2.2.0-beta.12

### Minor Changes

- 010ee0f: Fix `restoreSession` so runtime-permission-grant operations work after
  session restore (notably the OpenKey-backed CLI path).

  `TinyCloudNode.restoreSession` populated `_serviceContext.session` (the
  `ServiceSession` used by service invokers) but never set
  `auth.tinyCloudSession` (the richer `TinyCloudSession` that surfaces the
  SIWE recap, address, chain, etc.). Methods that read from the latter —
  `hasRuntimePermissions`, `getRuntimePermissionDelegations`,
  `useRuntimeDelegation`, `grantRuntimePermissions` — therefore threw
  `SessionExpiredError(new Date(0))` immediately after every restore.

  Symptoms:
  - `tc auth request --cap …` fails with `Session expired at 1970-01-01T00:00:00.000Z`
  - Persisted runtime delegations replayed via `useRuntimeDelegation` are
    rejected, so `tc auth caps` reports `granted: []` even when
    `additional-delegations.json` has live entries.

  Changes:
  - `restoreSession` now accepts optional `siwe` and `signature` fields.
  - When `siwe` + `address` + `chainId` are provided, a full
    `TinyCloudSession` is rehydrated. In wallet mode it lands on
    `auth.tinyCloudSession` via the new
    `NodeUserAuthorization.setRestoredTinyCloudSession`. In session-only
    mode (no auth layer — typical for OpenKey-restored CLIs) it lands on
    a new `TinyCloudNode._restoredTcSession` field.
  - A new private `currentTinyCloudSession()` helper resolves the active
    session from either surface. The four runtime-permission readers
    (`hasRuntimePermissions`, `getRuntimePermissionDelegations`,
    `useRuntimeDelegation`, `grantRuntimePermissions`) now consult it.

  CLI side (`@tinycloud/cli`): `replayAdditionalDelegations` exposes a
  `TC_DEBUG_REPLAY=1` env switch that prints which stored delegations
  fail to install and why. Useful for diagnosing future restore-related
  issues.

  Backwards compatible: `restoreSession`'s new parameters are optional;
  old callers continue to work, they just don't get runtime-grant
  support until they pass `siwe`. The CLI was already passing `siwe` —
  the SDK was just dropping it.

- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

### Patch Changes

- Updated dependencies [0e049d7]
- Updated dependencies [f43143d]
  - @tinycloud/node-sdk-wasm@1.7.3-beta.2
  - @tinycloud/sdk-core@2.2.0-beta.12

## 2.2.0-beta.11

### Minor Changes

- 9ff4b34: Introduce `EXPIRY` tiers as the single source of truth for default
  delegation lifetimes. Pick a tier, not a number, when adding a new
  delegation surface.

  The five tiers, exported from `@tinycloud/sdk-core`:
  - `EXPIRY.EPHEMERAL_MS` (1h) — auto-refreshable, never user-visible.
  - `EXPIRY.SESSION_MS` (7d) — sign-in sessions and runtime grants
    (capped by session anyway).
  - `EXPIRY.SHARE_MS` (7d) — share links and ad-hoc third-party
    delegations.
  - `EXPIRY.APP_MS` (30d) — manifest-declared installs.
  - `EXPIRY.MAX_MS` (10y) — caller-supplied upper bound.

  Behavior changes:
  - **`SharingService` share-link default: 24h → 7d.** Same direction as
    the runtime-grant default that already shipped at 7d. Callers passing
    explicit expiry are unaffected.
  - **`DelegationManager.create()` default: 24h → 7d** when the caller
    omits `expiry`.
  - **`SpaceService` server-response fallback: 24h → 7d** when the
    server's delegation response lacks an `expiry` field.
  - **`NodeUserAuthorization.sessionExpirationMs` default: 1h → 7d.**
    Fixes a silent inconsistency where direct `NodeUserAuthorization`
    consumers got 1h while `TinyCloudNode` users got 7d.
  - **`TinyCloudNode` public-space sub-delegation: 1h** (unchanged value,
    re-tagged as `EPHEMERAL` to make the intent legible — these are
    re-derived transparently on every public-space touch).

  Sites unchanged in value but re-pointed at tiered constants:
  - `TinyCloudNode.DEFAULT_SESSION_EXPIRATION_MS` → `EXPIRY.SESSION_MS`
  - `delegateToHelpers.DEFAULT_DELEGATION_EXPIRY_MS` → `EXPIRY.SESSION_MS`
  - `manifest.DEFAULT_EXPIRY` (`"30d"`) — still ms-format string for
    parser compatibility, comment now points at `EXPIRY.APP_MS`.

- 9ff4b34: Default delegation lifetime bumped to 7 days; default session lifetime
  bumped to 7 days; CLI gains `tc auth request --expiry`.

  Why: 1-hour grants forced agent workflows to re-prompt the user for caps
  they had already approved on every CLI invocation past the first hour.
  The session itself defaulted to 1 hour too, so even an explicit
  `--expiry 30d` couldn't outlive its parent. Both defaults moved to 7
  days so the common agent loop runs unattended for a week.
  - `delegateToHelpers.resolveExpiryMs(undefined)` now returns
    `DEFAULT_DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000`.
  - `TinyCloudNodeConfig.sessionExpirationMs` default is now
    `DEFAULT_SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000`. Existing
    callers passing an explicit value are unaffected. Wallet-mode SIWE
    sessions cap at 1 hour by protocol — that limit is independent of
    this default.
  - `tc auth request --expiry <duration>` accepts a ms-format string
    (`"7d"`, `"30m"`) or raw millisecond integer. Forwarded to
    `node.grantRuntimePermissions(permissions, { expiry })` for the
    local-key path and encoded into the OpenKey `/delegate?expiry=...`
    URL parameter for the OpenKey path. OpenKey-side support landed
    separately in TinyCloudLabs/openkey.

### Patch Changes

- 9ff4b34: CLI: agent-friendly permission management and cross-space SQL.
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

- Updated dependencies [9ff4b34]
  - @tinycloud/sdk-core@2.2.0-beta.11

## 2.2.0-beta.10

### Minor Changes

- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.

### Patch Changes

- Updated dependencies [35212bb]
  - @tinycloud/sdk-core@2.2.0-beta.10

## 2.2.0-beta.9

### Minor Changes

- 78ef7eb: Add `tinycloud.vault` as an SDK permission shorthand that expands to the backing KV permissions used by encrypted vault operations, including runtime permission escalation.

### Patch Changes

- Updated dependencies [78ef7eb]
  - @tinycloud/sdk-core@2.2.0-beta.9

## 2.2.0-beta.8

### Minor Changes

- 8367cef: Store approved runtime permissions as narrow portable delegations and route matching invocations through them instead of expanding the app manifest and re-signing the whole session. `delegateTo()` can now derive from an installed runtime delegation, web permission requests return any created runtime delegations, and the secrets wrapper can use the SDK's connected signer when unlocking the backing vault.

## 2.2.0-beta.7

### Minor Changes

- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.

### Patch Changes

- Updated dependencies [46f126a]
  - @tinycloud/sdk-core@2.2.0-beta.7

## 2.2.0-beta.6

### Patch Changes

- b9a24b5: Add implicit space-level `tinycloud.capabilities/read` grants for every space touched by a manifest request.
- Updated dependencies [b9a24b5]
  - @tinycloud/sdk-core@2.2.0-beta.6

## 2.2.0-beta.5

### Patch Changes

- 9ab4644: Check whether the manifest account registry space already exists before hosting it during sign-in, avoiding repeated account-space host prompts.
- Updated dependencies [9dc2e8c]
  - @tinycloud/node-sdk-wasm@1.7.3-beta.1

## 2.2.0-beta.4

### Minor Changes

- 0401ff8: Add default TinyCloud host discovery and run it from sign-in when no explicit host is configured.

### Patch Changes

- Updated dependencies [0401ff8]
  - @tinycloud/sdk-core@2.2.0-beta.4

## 2.2.0-beta.3

### Patch Changes

- Updated dependencies [2305a65]
  - @tinycloud/sdk-core@2.2.0-beta.3

## 2.2.0-beta.2

### Patch Changes

- 04a0d5c: Expose `DelegatedAccess.restorable` — a read-only projection of the activated session handles (`delegationHeader`, `delegationCid`, `spaceId`, `jwk`, `verificationMethod`, `address`, `chainId`) in the exact shape `TinyCloudNode.restoreSession(...)` consumes. Enables persisting a `useDelegation` activation across processes or restarts (e.g. agent runtimes that want vanilla `@tinycloud/cli` to operate against a delegated space). Note: in wallet mode the header/cid are minted against the activator's server-side session and expire with it (~1h), so callers must periodically re-run `useDelegation` + `restoreSession`.

## 2.2.0-beta.1

### Patch Changes

- Updated dependencies [de4d662]
  - @tinycloud/sdk-core@2.2.0-beta.1

## 2.2.0-beta.0

### Minor Changes

- 6561589: Add manifest v1 composition helpers, per-space capability requests, materialized manifest delegations, and the default account-space application registry grant.

### Patch Changes

- Updated dependencies [6561589]
  - @tinycloud/sdk-core@2.2.0-beta.0
  - @tinycloud/node-sdk-wasm@1.7.3-beta.0

## 2.1.0

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

- 9dad135: Wire manifest-driven `signIn` and multi-resource `delegateTo` end-to-end (closes the two gaps in `2.1.0-beta.1`).

  `signIn` now reads `config.manifest` and resolves it (via `resolveManifest` + the new `manifestAbilitiesUnion`) into the WASM `abilities` map used by `prepareSession`. The resulting SIWE recap covers the union of the app's own permissions AND every manifest-declared delegation's permissions, so the session key acquires coverage for both runtime use and downstream sub-delegations in one wallet prompt. Apps that don't pass a manifest fall back to `defaultActions` (legacy behaviour, no change).

  `delegateTo(did, permissions)` no longer rejects multi-entry input. The SDK now folds every `(service, path, actions)` entry into a single multi-resource abilities map and calls the WASM `createDelegation` once — producing ONE signed UCAN whose `attenuation` carries every grant. The returned `PortableDelegation` has the new optional `resources?: DelegatedResource[]` field listing the full breakdown; the legacy flat `path` + `actions` fields mirror the first (sorted) resource for back-compat.

  Listen-style apps that needed to delegate KV + SQL on the same prefix to a backend can now do so in a single `tcw.delegateTo(backendDID, [...])` call with no wallet prompt.

  **Breaking changes** — pre-2.1.0-beta.2 callers will need to update:
  - `@tinycloud/sdk-core`: `CreateDelegationWasmParams` swaps `path: string; actions: string[]` for `abilities: Record<string, Record<string, string[]>>`. `CreateDelegationWasmResult` swaps the flat `path` + `actions` for `resources: DelegatedResource[]`. New exports: `DelegatedResource`, `AbilitiesMap`, `manifestAbilitiesUnion`, `resourceCapabilitiesToAbilitiesMap`.
  - `@tinycloud/node-sdk`: `TinyCloudNodeConfig` gains an optional `manifest?: Manifest` field. `TinyCloudNode` gains `setManifest(manifest)` and `manifest` getter passthroughs to the underlying auth handler. `delegateTo` no longer throws on multi-entry input — apps that relied on that behaviour for validation must add their own length check. `PortableDelegation` gains an optional `resources?: DelegatedResource[]` field.
  - `@tinycloud/web-sdk`: `TinyCloudWeb.setManifest()` now forwards the new manifest into the underlying `TinyCloudNode` so the next `signIn()` picks it up. `BrowserWasmBindings.createDelegation` signature aligned with the new WASM ABI.
  - `@tinycloud/node-sdk-wasm` / `@tinycloud/web-sdk-wasm`: the `createDelegation` WASM export takes `abilities: object` (multi-resource map) instead of `path: string, actions: string[]`. The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the merge commit of the `feat/create-delegation-multi-resource` PR in `tinycloud-node`.

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

### Patch Changes

- 303a8eb: Add an optional per-call `nonce` override to `signIn()` while preserving constructor-level `siweConfig.nonce` support.
- b88728a: fix(sdk-core): normalize space URI in recap parse for derivability check

  The Rust WASM `parseRecapFromSiwe` returns `space` as the full recap target
  URI (`tinycloud:pkh:eip155:{chainId}:{address}:{name}`), while manifest
  permissions and backend-advertised permissions use the short `{name}` form
  (e.g. `"default"`). `isCapabilitySubset` was doing strict string comparison
  on `space`, so mixing the two forms always failed — `delegateTo` would throw
  `PermissionNotInManifestError` even when the session recap covered every
  requested capability.

  This broke end-to-end manifest-driven sign-in in the listen app, where the
  session SIWE was signed correctly with the union of all manifest abilities
  but `delegateTo(backendDID, info.permissions)` still failed on the subset
  check because `"tinycloud:pkh:eip155:1:0xd559...:default"` and `"default"`
  didn't match as strings.

  Fix: add a `normalizeSpace` helper that extracts the trailing name segment
  from a `tinycloud:` URI. Apply it in `parseRecapCapabilities` (so the output
  is always in short-name form) and defensively in `isCapabilitySubset` on
  both sides (so callers passing either form work transparently).

- c586568: fix(node-sdk): activate WASM-path delegations with the host so downstream consumers can reference the parent CID

  `createDelegationViaWasmPath` (the session-key UCAN fast path used by
  `tcw.delegateTo` when the requested capabilities are derivable from the
  current session) was building the UCAN client-side and returning it
  directly without posting it to the host. This meant the host's delegation
  store never saw the UCAN.

  When a downstream consumer (e.g. a backend calling `node.useDelegation`)
  tried to reference the UCAN's CID as the parent of its own invoker SIWE,
  the host's chain-validation step failed with "Cannot find parent
  delegation" — the host looks up parents by CID in its local database,
  and the client-side-only UCAN was never stored.

  Fix: after computing the UCAN in `createDelegationViaWasmPath`, call
  `activateSessionWithHost` to POST the delegation header to `/delegate`
  before returning the `PortableDelegation`. This mirrors the legacy
  `createDelegationWalletPath` which has done the same for wallet-signed
  SIWE delegations since day one.

- 4fac901: Publish the UCAN delegation header fix from PR #192.

  `createDelegationViaWasmPath` now activates session-key UCAN delegations with
  the raw serialized JWT in the `Authorization` header instead of prefixing it
  with `Bearer `. The TinyCloud host decodes this header directly as a UCAN JWT;
  the prefixed value causes host activation to fail with 401 during
  manifest-driven `delegateTo` flows such as TinyBoilerplate/OpenKey sign-in.

- fb1d3fd: Trigger republish after CI auth fix — nonce passthrough fix shipped in prior beta was not published to npm due to broken publish step.
- Updated dependencies [303a8eb]
- Updated dependencies [8abfb4e]
- Updated dependencies [b55ffbd]
- Updated dependencies [b88728a]
- Updated dependencies [c586568]
- Updated dependencies [9dad135]
- Updated dependencies [9a9fae1]
- Updated dependencies [fb1d3fd]
- Updated dependencies [61c031d]
  - @tinycloud/sdk-core@2.1.0
  - @tinycloud/node-sdk-wasm@1.7.2

## 2.1.0-beta.6

### Patch Changes

- 4fac901: Publish the UCAN delegation header fix from PR #192.

  `createDelegationViaWasmPath` now activates session-key UCAN delegations with
  the raw serialized JWT in the `Authorization` header instead of prefixing it
  with `Bearer `. The TinyCloud host decodes this header directly as a UCAN JWT;
  the prefixed value causes host activation to fail with 401 during
  manifest-driven `delegateTo` flows such as TinyBoilerplate/OpenKey sign-in.

## 2.1.0-beta.5

### Patch Changes

- 303a8eb: Add an optional per-call `nonce` override to `signIn()` while preserving constructor-level `siweConfig.nonce` support.
- Updated dependencies [303a8eb]
  - @tinycloud/sdk-core@2.1.0-beta.5

## 2.1.0-beta.4

### Patch Changes

- c586568: fix(node-sdk): activate WASM-path delegations with the host so downstream consumers can reference the parent CID

  `createDelegationViaWasmPath` (the session-key UCAN fast path used by
  `tcw.delegateTo` when the requested capabilities are derivable from the
  current session) was building the UCAN client-side and returning it
  directly without posting it to the host. This meant the host's delegation
  store never saw the UCAN.

  When a downstream consumer (e.g. a backend calling `node.useDelegation`)
  tried to reference the UCAN's CID as the parent of its own invoker SIWE,
  the host's chain-validation step failed with "Cannot find parent
  delegation" — the host looks up parents by CID in its local database,
  and the client-side-only UCAN was never stored.

  Fix: after computing the UCAN in `createDelegationViaWasmPath`, call
  `activateSessionWithHost` to POST the delegation header to `/delegate`
  before returning the `PortableDelegation`. This mirrors the legacy
  `createDelegationWalletPath` which has done the same for wallet-signed
  SIWE delegations since day one.

- Updated dependencies [c586568]
  - @tinycloud/sdk-core@2.1.0-beta.4

## 2.1.0-beta.3

### Patch Changes

- b88728a: fix(sdk-core): normalize space URI in recap parse for derivability check

  The Rust WASM `parseRecapFromSiwe` returns `space` as the full recap target
  URI (`tinycloud:pkh:eip155:{chainId}:{address}:{name}`), while manifest
  permissions and backend-advertised permissions use the short `{name}` form
  (e.g. `"default"`). `isCapabilitySubset` was doing strict string comparison
  on `space`, so mixing the two forms always failed — `delegateTo` would throw
  `PermissionNotInManifestError` even when the session recap covered every
  requested capability.

  This broke end-to-end manifest-driven sign-in in the listen app, where the
  session SIWE was signed correctly with the union of all manifest abilities
  but `delegateTo(backendDID, info.permissions)` still failed on the subset
  check because `"tinycloud:pkh:eip155:1:0xd559...:default"` and `"default"`
  didn't match as strings.

  Fix: add a `normalizeSpace` helper that extracts the trailing name segment
  from a `tinycloud:` URI. Apply it in `parseRecapCapabilities` (so the output
  is always in short-name form) and defensively in `isCapabilitySubset` on
  both sides (so callers passing either form work transparently).

- Updated dependencies [b88728a]
  - @tinycloud/sdk-core@2.1.0-beta.3

## 2.1.0-beta.2

### Minor Changes

- 9dad135: Wire manifest-driven `signIn` and multi-resource `delegateTo` end-to-end (closes the two gaps in `2.1.0-beta.1`).

  `signIn` now reads `config.manifest` and resolves it (via `resolveManifest` + the new `manifestAbilitiesUnion`) into the WASM `abilities` map used by `prepareSession`. The resulting SIWE recap covers the union of the app's own permissions AND every manifest-declared delegation's permissions, so the session key acquires coverage for both runtime use and downstream sub-delegations in one wallet prompt. Apps that don't pass a manifest fall back to `defaultActions` (legacy behaviour, no change).

  `delegateTo(did, permissions)` no longer rejects multi-entry input. The SDK now folds every `(service, path, actions)` entry into a single multi-resource abilities map and calls the WASM `createDelegation` once — producing ONE signed UCAN whose `attenuation` carries every grant. The returned `PortableDelegation` has the new optional `resources?: DelegatedResource[]` field listing the full breakdown; the legacy flat `path` + `actions` fields mirror the first (sorted) resource for back-compat.

  Listen-style apps that needed to delegate KV + SQL on the same prefix to a backend can now do so in a single `tcw.delegateTo(backendDID, [...])` call with no wallet prompt.

  **Breaking changes** — pre-2.1.0-beta.2 callers will need to update:
  - `@tinycloud/sdk-core`: `CreateDelegationWasmParams` swaps `path: string; actions: string[]` for `abilities: Record<string, Record<string, string[]>>`. `CreateDelegationWasmResult` swaps the flat `path` + `actions` for `resources: DelegatedResource[]`. New exports: `DelegatedResource`, `AbilitiesMap`, `manifestAbilitiesUnion`, `resourceCapabilitiesToAbilitiesMap`.
  - `@tinycloud/node-sdk`: `TinyCloudNodeConfig` gains an optional `manifest?: Manifest` field. `TinyCloudNode` gains `setManifest(manifest)` and `manifest` getter passthroughs to the underlying auth handler. `delegateTo` no longer throws on multi-entry input — apps that relied on that behaviour for validation must add their own length check. `PortableDelegation` gains an optional `resources?: DelegatedResource[]` field.
  - `@tinycloud/web-sdk`: `TinyCloudWeb.setManifest()` now forwards the new manifest into the underlying `TinyCloudNode` so the next `signIn()` picks it up. `BrowserWasmBindings.createDelegation` signature aligned with the new WASM ABI.
  - `@tinycloud/node-sdk-wasm` / `@tinycloud/web-sdk-wasm`: the `createDelegation` WASM export takes `abilities: object` (multi-resource map) instead of `path: string, actions: string[]`. The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the merge commit of the `feat/create-delegation-multi-resource` PR in `tinycloud-node`.

### Patch Changes

- Updated dependencies [9dad135]
  - @tinycloud/sdk-core@2.1.0-beta.2
  - @tinycloud/node-sdk-wasm@1.7.2-beta.2

## 2.1.0-beta.1

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

### Patch Changes

- Updated dependencies [8abfb4e]
  - @tinycloud/sdk-core@2.1.0-beta.1
  - @tinycloud/node-sdk-wasm@1.7.2-beta.1

## 2.1.0-beta.0

### Minor Changes

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

### Patch Changes

- Updated dependencies [b55ffbd]
- Updated dependencies [9a9fae1]
- Updated dependencies [61c031d]
  - @tinycloud/sdk-core@2.1.0-beta.0
  - @tinycloud/node-sdk-wasm@1.7.2-beta.0

## 2.0.4-beta.0

### Patch Changes

- fb1d3fd: Trigger republish after CI auth fix — nonce passthrough fix shipped in prior beta was not published to npm due to broken publish step.
- Updated dependencies [fb1d3fd]
  - @tinycloud/sdk-core@2.0.4-beta.0

## 2.0.3

### Patch Changes

- e7e6ee7: Fix SIWE domain to default to app.tinycloud.xyz instead of TinyCloud node URL
- 1379b11: Preserve `siweConfig` when upgrading from session-only mode via `connectWallet()` or `connectSigner()`
- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.

- Updated dependencies [c2f2d54]
- Updated dependencies [e422647]
  - @tinycloud/sdk-core@2.0.3
  - @tinycloud/node-sdk-wasm@1.7.1

## 2.0.3-beta.3

### Patch Changes

- 1379b11: Preserve `siweConfig` when upgrading from session-only mode via `connectWallet()` or `connectSigner()`
- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.

- Updated dependencies [e422647]
  - @tinycloud/sdk-core@2.0.3-beta.3

## 2.0.3-beta.2

### Patch Changes

- Updated dependencies [c2f2d54]
  - @tinycloud/sdk-core@2.0.3-beta.2

## 2.0.3-beta.0

### Patch Changes

- e7e6ee7: Fix SIWE domain to default to app.tinycloud.xyz instead of TinyCloud node URL

## 2.0.2

### Patch Changes

- 3401b3c: Fix siweConfig.nonce passthrough to SIWE message generation

  The nonce field from siweConfig was accepted in the configuration but never
  forwarded to the WASM prepareSession() call, causing server-provided nonces
  to be silently ignored. This broke single-signature auth flows where an
  external service (e.g. billing sidecar) provides a nonce for verification.

- Updated dependencies [7bb188f]
  - @tinycloud/sdk-core@2.0.2

## 2.0.1

### Patch Changes

- @tinycloud/sdk-core@2.0.1

## 2.0.0

### Minor Changes

- 6eebc29: Unify web-sdk and node-sdk: TinyCloudWeb is now a thin wrapper around TinyCloudNode.

  Breaking changes (web-sdk):
  - `@tinycloud/web-core` package deleted — import types from `@tinycloud/sdk-core` or `@tinycloud/web-sdk`
  - `WebUserAuthorization` class removed — use `tcw.session()`, `tcw.did`, `tcw.address()` instead
  - `tcw.webAuth` and `tcw.userAuthorization` accessors removed
  - `WebSignStrategy` / `WalletPopupStrategy` types removed

  New in node-sdk:
  - `signer`, `wasmBindings`, `notificationHandler`, `ensResolver`, `spaceCreationHandler` config options
  - `connectSigner()` method for injecting any ISigner
  - `@tinycloud/node-sdk/core` entry point (zero Node WASM deps, for browser bundlers)
  - `restoreSession()` now initializes Vault

  New in sdk-core:
  - `INotificationHandler`, `IENSResolver`, `IWasmBindings`, `ISessionManager` interfaces
  - `ClientSession`, `SiweConfig`, `EnsData` types (moved from web-core)

  New in web-sdk:
  - `sql`, `duckdb` services now available
  - Browser adapters: `BrowserWalletSigner`, `BrowserSessionStorage`, `BrowserNotificationHandler`, `BrowserWasmBindings`, `BrowserENSResolver`
  - ENS name resolution in delegation methods

### Patch Changes

- Updated dependencies [6eebc29]
  - @tinycloud/sdk-core@2.0.0

## 1.7.0

### Patch Changes

- def099d: Skip redundant public key writes on vault unlock and auto-include public-space KV delegation when creating delegations with KV actions. Remove unused VaultAction constants.
- Updated dependencies [8649de8]
  - @tinycloud/node-sdk-wasm@1.7.0
  - @tinycloud/sdk-core@1.7.0
  - @tinycloud/web-core@1.7.0

## 1.6.0

### Minor Changes

- db50ae4: Add DuckDB service to the TypeScript SDK. Provides `tc.duckdb` for querying and managing DuckDB databases on TinyCloud nodes, including `query()`, `queryArrow()`, `execute()`, `batch()`, `describe()`, `export()`, and `import()` operations. Named database handles via `tc.duckdb.database()`. SDK services are now conditionally initialized based on node feature detection — accessing an unsupported service throws `UnsupportedFeatureError`.

### Patch Changes

- Updated dependencies [9454b78]
- Updated dependencies [db50ae4]
- Updated dependencies [bea6063]
  - @tinycloud/sdk-core@1.6.0
  - @tinycloud/node-sdk-wasm@1.6.0
  - @tinycloud/web-core@1.6.0

## 1.5.0

### Patch Changes

- @tinycloud/sdk-core@1.5.0

## 1.4.1

### Patch Changes

- Updated dependencies [da5a499]
  - @tinycloud/node-sdk-wasm@1.4.1

## 1.4.0

### Minor Changes

- fd25623: Add browser-based delegate auth flow for CLI login via OpenKey. The CLI opens a `/delegate` page where users authenticate with a passkey, select a key, and approve a delegation. `TinyCloudNode.restoreSession()` allows injecting stored delegation data without a private key. Also fixes `kv list` result parsing and CLI process hang after auth.

## 1.3.0

### Minor Changes

- 94ad509: Add Data Vault (encrypted KV) support with WASM crypto bindings, vault service initialization in TinyCloudWeb, public space helpers, and NodeUserAuthorization improvements
- 94ad509: Add Data Vault service for client-side encrypted KV storage with X25519 key exchange and AES-256-GCM encryption
- 94ad509: Add multi-space session support with enablePublicSpace config (default: true). Single signIn covers both primary and public space. Fix space-scoped KV factory to properly scope to target space.
- 94ad509: Add public space support for discoverable, unauthenticated data publishing
  - `makePublicSpaceId(address, chainId)` utility for deterministic public space ID construction
  - `TinyCloud.ensurePublicSpace()` creates the user's public space on first need
  - `TinyCloud.publicKV` getter returns IKVService scoped to the user's public space
  - `TinyCloud.readPublicSpace(host, spaceId, key)` static method for unauthenticated reads
  - `TinyCloud.readPublicKey(host, address, chainId, key)` static convenience method

- 94ad509: Register DataVaultService in TinyCloudNode with WASM crypto bindings and rewrite vault demo to use SDK

### Patch Changes

- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
  - @tinycloud/sdk-core@1.3.0

## 1.2.0

### Minor Changes

- 2014a20: Add sessionStorage to TinyCloudNodeConfig types and switch build to tsup for proper ESM/CJS output
- bcbebbe: Add public space support for discoverable, unauthenticated data publishing
  - `makePublicSpaceId(address, chainId)` utility for deterministic public space ID construction
  - `TinyCloud.ensurePublicSpace()` creates the user's public space on first need
  - `TinyCloud.publicKV` getter returns IKVService scoped to the user's public space
  - `TinyCloud.readPublicSpace(host, spaceId, key)` static method for unauthenticated reads
  - `TinyCloud.readPublicKey(host, address, chainId, key)` static convenience method

- ca9b2c6: Add SQL service (tinycloud.sql/\*) with full TypeScript SDK support
  - New SQLService in sdk-services: query, execute, batch, executeStatement, export
  - DatabaseHandle for per-database operations
  - SQL re-exports in sdk-core with TinyCloud.sql getter
  - Node-SDK: SQL wiring in TinyCloudNode, DelegatedAccess, root delegation defaults
  - Fix type-only re-exports preventing bun runtime resolution

### Patch Changes

- Updated dependencies [bcbebbe]
- Updated dependencies [ca9b2c6]
  - @tinycloud/sdk-core@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [855e0d9]
- Updated dependencies [ba988fb]
  - @tinycloud/sdk-core@1.1.0
  - @tinycloud/web-core@1.1.0

## 1.0.1

### Patch Changes

- Updated dependencies [c97e40d]
  - @tinycloud/node-sdk-wasm@1.0.1
  - @tinycloud/web-core@1.0.1
  - @tinycloud/sdk-core@1.0.1

## 1.0.0

### Major Changes

- 866981c: # v1.0.0 Release

  ## Protocol Version System
  - Added `checkNodeVersion()` to all sign-in flows for SDK-node compatibility verification
  - Added `ProtocolMismatchError` and `VersionCheckError` error types
  - SDK now requires TinyCloud Node v1.0.0+ with `/version` endpoint

  ## API Surface Cleanup
  - Replaced blanket `export *` with explicit curated exports
  - Renamed 40+ `TCW`-prefixed types (e.g. `TCWClientSession` -> `ClientSession`, `TCWExtension` -> `Extension`)
  - Trimmed internal utilities from public API surface

  ## Breaking Changes
  - All `TCW`-prefixed types have been renamed (drop the `TCW` prefix)
  - Blanket re-exports from `@tinycloudlabs/web-core` removed; use explicit named imports
  - Some internal sdk-core utilities removed from public API
  - `SharingServiceV2` alias removed; use `SharingService` directly

### Patch Changes

- b863afb: Fix sharing link delegation bugs
  - Fix 401 Unauthorized error: Clamp sharing link expiry to session expiry to ensure child delegation expiry never exceeds parent
  - Fix "Invalid symbol 32" base64 decode error: Remove incorrect "Bearer " prefix from authHeader in sharing link data

- Updated dependencies [b863afb]
- Updated dependencies [866981c]
  - @tinycloudlabs/sdk-core@1.0.0
  - @tinycloudlabs/web-core@1.0.0
  - @tinycloudlabs/node-sdk-wasm@1.0.0

## 0.2.0

### Minor Changes

- a2b4b66: Breaking API changes for node-sdk delegation system

  ### node-sdk

  **BREAKING: `allowSubDelegation` → `disableSubDelegation`**
  - Sub-delegation is now allowed by default (aligns with ocap/UCAN expectations)
  - Use `disableSubDelegation: true` to prevent recipients from creating sub-delegations
  - Before: `createDelegation({ allowSubDelegation: true })` to enable
  - After: `createDelegation({})` enables by default, use `disableSubDelegation: true` to disable

  **BREAKING: `autoCreateNamespace` default changed to `false`**
  - Namespaces are no longer auto-created during sign-in
  - Use `autoCreateNamespace: true` explicitly for namespace owners
  - Delegates using shared namespaces should not set this flag

  ### web-sdk
  - Fixed `KVServiceAdapter` to include `jwk` property required by `ServiceSession`

### Patch Changes

- a2b4b66: Create node-sdk package with Node.js-specific TinyCloud SDK implementations.

  This package provides:
  - `PrivateKeySigner`: ISigner implementation using private keys via WASM
  - `NodeUserAuthorization`: IUserAuthorization with configurable sign strategies
    - auto-sign: Automatically approve all sign requests
    - auto-reject: Reject all sign requests
    - callback: Delegate to custom callback function
    - event-emitter: Emit sign requests as events
  - `MemorySessionStorage`: In-memory ISessionStorage
  - `FileSessionStorage`: File-based ISessionStorage for session persistence

  Part of TC-401: IUserAuthorization shared interface implementation.

- a2b4b66: Fix delegation chain support for user-to-user delegations
  - Added `pkhDid` getter for PKH DID format (`did:pkh:eip155:{chainId}:{address}`)
  - Fixed `createDelegation` to use `delegateUri` for targeting recipient's PKH DID
  - Fixed `createSubDelegation` to use `delegateUri` instead of generating random JWK
  - Fixed sub-delegation expiry to cap at parent's expiry instead of throwing error
  - Updated demo to use `pkhDid` for all delegations

  Full delegation chain now works: Alice → Bob → Charlie

- Updated dependencies [a2b4b66]
- Updated dependencies [a2b4b66]
- Updated dependencies [a2b4b66]
  - @tinycloudlabs/sdk-core@0.2.0
  - @tinycloudlabs/node-sdk-wasm@0.1.1
  - @tinycloudlabs/web-core@0.3.1
