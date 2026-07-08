# @tinycloudlabs/sdk-services

## 2.6.1

### Patch Changes

- bf31506: Stop emitting a doomed `tinycloud.space/list` invocation after manifest/recap
  sign-in (TC-110).

  `scheduleAccountRegistrySync()` unconditionally called
  `account.spaces.syncAccessible()`, which invokes `tinycloud.space/list` — a
  capability a manifest/recap session never holds — producing a benign but noisy
  `401 Unauthorized Action: …/space/ tinycloud.space/list` on every sign-in
  (visible in browser consoles).

  The sync now skips `syncAccessible()` when the current session's recap does not
  grant `tinycloud.space/list`, reusing the TC-111 `recapOperationsFromSession`
  primitive. Only sessions without a SIWE recap (session-only /
  restored-without-siwe) keep today's behavior — every wallet SIWE session in
  this stack carries a recap, and none of them grant `space/list`, so all of
  them skip.

  Behavior note: `syncAccessible()` on this path could only ever register
  capability-registry-derived **delegated** spaces (the owned-space listing 401
  was already swallowed by `SpaceService.list`). That sign-in-time delegated
  registration no longer happens; owned spaces are unaffected (bootstrap seeding
  - `spaces.register()`), and `account.spaces.list({ preferIndex: true })`
    self-heals via its own `syncAccessible()` fallback.

  Additionally, `withAccountRegistryRetry` no longer retries authorization
  verdicts (`Unauthorized Action` / 401): those are deterministic, not transient,
  so it warns once and stops instead of re-emitting the doomed request. Generic
  errors still get the full retry budget.

  Guard only — no registry-convergence writes and no sdk-core changes; the CLI
  (`tc account spaces sync`) still uses `syncAccessible()` for explicit discovery.

- Updated dependencies [cd2aeb1]
  - @tinycloud/bootstrap@2.5.1

## 2.6.1-beta.1

### Patch Changes

- Updated dependencies [cd2aeb1]
  - @tinycloud/bootstrap@2.5.1-beta.0

## 2.6.1-beta.0

### Patch Changes

- bf31506: Stop emitting a doomed `tinycloud.space/list` invocation after manifest/recap
  sign-in (TC-110).

  `scheduleAccountRegistrySync()` unconditionally called
  `account.spaces.syncAccessible()`, which invokes `tinycloud.space/list` — a
  capability a manifest/recap session never holds — producing a benign but noisy
  `401 Unauthorized Action: …/space/ tinycloud.space/list` on every sign-in
  (visible in browser consoles).

  The sync now skips `syncAccessible()` when the current session's recap does not
  grant `tinycloud.space/list`, reusing the TC-111 `recapOperationsFromSession`
  primitive. Only sessions without a SIWE recap (session-only /
  restored-without-siwe) keep today's behavior — every wallet SIWE session in
  this stack carries a recap, and none of them grant `space/list`, so all of
  them skip.

  Behavior note: `syncAccessible()` on this path could only ever register
  capability-registry-derived **delegated** spaces (the owned-space listing 401
  was already swallowed by `SpaceService.list`). That sign-in-time delegated
  registration no longer happens; owned spaces are unaffected (bootstrap seeding
  - `spaces.register()`), and `account.spaces.list({ preferIndex: true })`
    self-heals via its own `syncAccessible()` fallback.

  Additionally, `withAccountRegistryRetry` no longer retries authorization
  verdicts (`Unauthorized Action` / 401): those are deterministic, not transient,
  so it warns once and stops instead of re-emitting the doomed request. Generic
  errors still get the full retry budget.

  Guard only — no registry-convergence writes and no sdk-core changes; the CLI
  (`tc account spaces sync`) still uses `syncAccessible()` for explicit discovery.

## 2.6.0

### Minor Changes

- 2f31800: Consolidate hand-written capability URN lists into a single source of truth
  (`@tinycloud/bootstrap` `capabilities` module, TC-112). The registry is defined
  in tinycloud-node and vendored verbatim as
  `@tinycloud/bootstrap/src/generated/capabilities.ts`; the per-service constants
  (`KV`, `SQL`, `DUCKDB`, …), `CAPABILITY_REGISTRY`, `SQLAction`, `DuckDbAction`,
  the node-sdk default abilities and root-delegation grants, the bootstrap
  manifests, and the web-sdk permission-modal labels are all derived from it. A CI
  job diffs the vendored copy against the node registry at the pinned rev so the
  SDK can never silently drift from the enforcer.

  BREAKING (minor, pre-1.0): `SQLAction.INSERT`, `SQLAction.UPDATE`, and
  `SQLAction.DELETE` are removed — they were never dispatched by the SDK nor
  accepted by the node. `SQLAction.SELECT` is retained as a deprecated alias of
  `read`. `SQLAction.EXECUTE`/`EXPORT` and `DuckDbAction.DESCRIBE`/`EXECUTE` are
  retained as exported constants but are request-kind artifacts, not registry
  capabilities (the node routes them by request-body kind; wire alignment tracked
  in TC-114). All other action shapes are unchanged.

### Patch Changes

- ac48f85: Fix runtime permission selection so the primary session's own recap always
  out-ranks any other covering runtime grant (TC-111).

  Previously `selectInvocationSession`/`invokeAnyWithRuntimePermissions` picked the
  first covering grant in insertion order, so a broad — possibly broken —
  bootstrap or delegated grant could hijack an operation the primary session
  itself already authorized and 401. The primary session is now registered as a
  synthetic highest-trust (`provenance: "primary"`) runtime grant built from the
  raw SIWE recap (full owner-scoped space URIs, so owners can never be conflated),
  and grant selection filters covering grants then prefers the primary. Spaces the
  node skipped activating this sign-in are excluded from the synthetic grant so it
  can never out-rank a working grant. The synthetic primary grant is never exposed
  through `getRuntimePermissionDelegations`/`hasRuntimePermissions`.

- 3ad0635: Mint the ability the node actually dispatches for SQL/DuckDB
  `execute`/`export`/`describe` (TC-114).

  `SQLService.executeStatementOnDb`/`exportDb` and
  `DuckDbService.executeStatementOnDb`/`describeDb` were sending the literal method
  name as the invocation ability (`tinycloud.sql/execute`,
  `tinycloud.sql/export`, `tinycloud.duckdb/execute`, `tinycloud.duckdb/describe`).
  The node has no such capabilities — it routes these requests by request-body
  kind gated by read/write/admin — so under chain containment a narrowly-delegated
  session (read+write, no `sql/*`/`duckdb/*` wildcard) 401s on these calls. They
  worked previously only because real grants carry the service wildcard.

  Each method now mints the dispatchable ability grounded in the node's routing:
  `export`/`describe` are authorized as reads (`tinycloud.{sql,duckdb}/read`) and
  named-statement execution as a write (`tinycloud.{sql,duckdb}/write`, which the
  SQL parser accepts for both read-only and mutating statements). Public method
  signatures and the exported `SQLAction`/`DuckDbAction` request-kind constants are
  unchanged. Narrowly-delegated sessions with no service wildcard now get working
  `export`, `executeStatement`, and `describe`.

- e07823b: Bump the tinycloud-node WASM-build pin to the v1.4.5 release tag and re-vendor
  the capability registry artifact (TC-119 / TC-121).

  `packages/sdk-rs/Cargo.toml` now pins `tinycloud-sdk-rs`/`tinycloud-sdk-wasm` to
  `tag = "v1.4.5"` (was `v1.4.2`). v1.4.5 is the first release that both contains
  the TC-112 capability registry AND wires it into the live `/invoke`//`/delegate`
  chain-containment paths (TC-119: alias/implication-aware delegation and
  invocation models). Unlike the v1.4.2 pin — where the registry was decoupled and
  the compiled WASM was unaffected — the WASM compiled from this pin genuinely
  changes (the `tinycloud-auth` crate it links in gained the W1 UCAN revocation
  handling shipped across v1.4.3–v1.4.5), so the published `web-sdk-wasm`/
  `node-sdk-wasm` binaries move.

  The vendored `@tinycloud/bootstrap` registry
  (`src/generated/capabilities.ts`) is re-vendored byte-identical from
  tinycloud-node@v1.4.5; the registry CONTENT (`REGISTRY_SOURCE_SHA256`,
  `CAPABILITIES`, `ALIASES`, `IMPLICATIONS`) is unchanged — only the new
  TC-121 `REGISTRY_SOURCE_REPO`/`REGISTRY_SOURCE_GIT_SHA` header exports and their
  doc comments are added. The capabilities-sync CI now anchors its fetch-and-diff
  to the explicit release-tag commit (`ANCHOR_NODE_REV`) rather than the header
  sha (which, for a locally-generated artifact, names the generation parent and
  would fetch the wrong artifact).

- Updated dependencies [2f31800]
  - @tinycloud/bootstrap@2.5.0

## 2.6.0-beta.3

### Patch Changes

- e07823b: Bump the tinycloud-node WASM-build pin to the v1.4.5 release tag and re-vendor
  the capability registry artifact (TC-119 / TC-121).

  `packages/sdk-rs/Cargo.toml` now pins `tinycloud-sdk-rs`/`tinycloud-sdk-wasm` to
  `tag = "v1.4.5"` (was `v1.4.2`). v1.4.5 is the first release that both contains
  the TC-112 capability registry AND wires it into the live `/invoke`//`/delegate`
  chain-containment paths (TC-119: alias/implication-aware delegation and
  invocation models). Unlike the v1.4.2 pin — where the registry was decoupled and
  the compiled WASM was unaffected — the WASM compiled from this pin genuinely
  changes (the `tinycloud-auth` crate it links in gained the W1 UCAN revocation
  handling shipped across v1.4.3–v1.4.5), so the published `web-sdk-wasm`/
  `node-sdk-wasm` binaries move.

  The vendored `@tinycloud/bootstrap` registry
  (`src/generated/capabilities.ts`) is re-vendored byte-identical from
  tinycloud-node@v1.4.5; the registry CONTENT (`REGISTRY_SOURCE_SHA256`,
  `CAPABILITIES`, `ALIASES`, `IMPLICATIONS`) is unchanged — only the new
  TC-121 `REGISTRY_SOURCE_REPO`/`REGISTRY_SOURCE_GIT_SHA` header exports and their
  doc comments are added. The capabilities-sync CI now anchors its fetch-and-diff
  to the explicit release-tag commit (`ANCHOR_NODE_REV`) rather than the header
  sha (which, for a locally-generated artifact, names the generation parent and
  would fetch the wrong artifact).

## 2.6.0-beta.2

### Patch Changes

- 3ad0635: Mint the ability the node actually dispatches for SQL/DuckDB
  `execute`/`export`/`describe` (TC-114).

  `SQLService.executeStatementOnDb`/`exportDb` and
  `DuckDbService.executeStatementOnDb`/`describeDb` were sending the literal method
  name as the invocation ability (`tinycloud.sql/execute`,
  `tinycloud.sql/export`, `tinycloud.duckdb/execute`, `tinycloud.duckdb/describe`).
  The node has no such capabilities — it routes these requests by request-body
  kind gated by read/write/admin — so under chain containment a narrowly-delegated
  session (read+write, no `sql/*`/`duckdb/*` wildcard) 401s on these calls. They
  worked previously only because real grants carry the service wildcard.

  Each method now mints the dispatchable ability grounded in the node's routing:
  `export`/`describe` are authorized as reads (`tinycloud.{sql,duckdb}/read`) and
  named-statement execution as a write (`tinycloud.{sql,duckdb}/write`, which the
  SQL parser accepts for both read-only and mutating statements). Public method
  signatures and the exported `SQLAction`/`DuckDbAction` request-kind constants are
  unchanged. Narrowly-delegated sessions with no service wildcard now get working
  `export`, `executeStatement`, and `describe`.

## 2.6.0-beta.1

### Patch Changes

- ac48f85: Fix runtime permission selection so the primary session's own recap always
  out-ranks any other covering runtime grant (TC-111).

  Previously `selectInvocationSession`/`invokeAnyWithRuntimePermissions` picked the
  first covering grant in insertion order, so a broad — possibly broken —
  bootstrap or delegated grant could hijack an operation the primary session
  itself already authorized and 401. The primary session is now registered as a
  synthetic highest-trust (`provenance: "primary"`) runtime grant built from the
  raw SIWE recap (full owner-scoped space URIs, so owners can never be conflated),
  and grant selection filters covering grants then prefers the primary. Spaces the
  node skipped activating this sign-in are excluded from the synthetic grant so it
  can never out-rank a working grant. The synthetic primary grant is never exposed
  through `getRuntimePermissionDelegations`/`hasRuntimePermissions`.

## 2.6.0-beta.0

### Minor Changes

- 2f31800: Consolidate hand-written capability URN lists into a single source of truth
  (`@tinycloud/bootstrap` `capabilities` module, TC-112). The registry is defined
  in tinycloud-node and vendored verbatim as
  `@tinycloud/bootstrap/src/generated/capabilities.ts`; the per-service constants
  (`KV`, `SQL`, `DUCKDB`, …), `CAPABILITY_REGISTRY`, `SQLAction`, `DuckDbAction`,
  the node-sdk default abilities and root-delegation grants, the bootstrap
  manifests, and the web-sdk permission-modal labels are all derived from it. A CI
  job diffs the vendored copy against the node registry at the pinned rev so the
  SDK can never silently drift from the enforcer.

  BREAKING (minor, pre-1.0): `SQLAction.INSERT`, `SQLAction.UPDATE`, and
  `SQLAction.DELETE` are removed — they were never dispatched by the SDK nor
  accepted by the node. `SQLAction.SELECT` is retained as a deprecated alias of
  `read`. `SQLAction.EXECUTE`/`EXPORT` and `DuckDbAction.DESCRIBE`/`EXECUTE` are
  retained as exported constants but are request-kind artifacts, not registry
  capabilities (the node routes them by request-body kind; wire alignment tracked
  in TC-114). All other action shapes are unchanged.

### Patch Changes

- Updated dependencies [2f31800]
  - @tinycloud/bootstrap@2.5.0-beta.0

## 2.4.2

## 2.4.1

## 2.4.0

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

- 895804a: Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.
- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

- bd8a60f: Remove the deprecated `SQLAction.DDL` export and the `tinycloud.sql/ddl` permission display path. SQL schema changes use `SQLAction.SCHEMA` and `tinycloud.sql/schema`.
- c94b81b: Fix `tc kv put`/`kv delete --space` and binary KV round-trips.
  - `tc kv put` and `tc kv delete` now accept `--space <name|uri>`, routing through
    the space-scoped KV (`kvForSpace`) like `get`/`list`/`head` already did. KV
    writes to a non-primary space (e.g. an `applications` space) are now possible
    from the CLI.
  - Binary KV values now round-trip byte-identically. `KVService.put` sends
    Blob/ArrayBuffer/typed-array/Buffer values as raw bytes
    (`application/octet-stream`, honoring an explicit `contentType`) instead of
    JSON-stringifying them into `{"type":"Buffer","data":[...]}`. A new
    `KVGetOptions.binary` returns the raw response bytes as a `Uint8Array`, and the
    CLI's `kv get -o <file>` / `--raw` use it so images and other binaries are
    written out unchanged.

- fa4a7c7: Add regression coverage for SQL migration batches that require both `tinycloud.sql/ddl` and `tinycloud.sql/write`, including the legacy-session runtime permission repair path used by TinyCloud Secrets.
- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.

## 2.4.0-beta.19

### Patch Changes

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.

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

## 2.4.0-beta.15

### Patch Changes

- bd8a60f: Remove the deprecated `SQLAction.DDL` export and the `tinycloud.sql/ddl` permission display path. SQL schema changes use `SQLAction.SCHEMA` and `tinycloud.sql/schema`.

## 2.4.0-beta.14

### Patch Changes

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

## 2.4.0-beta.12

### Patch Changes

- fa4a7c7: Add regression coverage for SQL migration batches that require both `tinycloud.sql/ddl` and `tinycloud.sql/write`, including the legacy-session runtime permission repair path used by TinyCloud Secrets.

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

## 2.4.0-beta.10

### Minor Changes

- 27f97d8: Add a public `ensureOwnedSpaceHosted(name)` method to `TinyCloudNode` and `TinyCloudWeb` for hosting an owner's owned space (e.g. `"secrets"`) from a session created with a manifest / capabilityRequest.

  A full-authority sign-in auto-hosts the owner's `secrets` space, but a session created with a manifest / capabilityRequest does not. Such a session could hold valid `tinycloud.kv/*` capabilities for the owned `secrets` space yet still fail its first scoped `secrets.put(...)` with `404 Space not found`, because the space was never registered on the node. `ensureOwnedSpaceHosted(name)` resolves the name to the owner's owned-space URI and hosts it via the host-SIWE delegation flow (one signature, idempotent server-side), so subsequent scoped secret writes succeed.

### Patch Changes

- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

## 2.4.0-beta.8

### Patch Changes

- 895804a: Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.

## 2.4.0-beta.2

### Patch Changes

- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

## 2.4.0-beta.1

### Patch Changes

- c94b81b: Fix `tc kv put`/`kv delete --space` and binary KV round-trips.
  - `tc kv put` and `tc kv delete` now accept `--space <name|uri>`, routing through
    the space-scoped KV (`kvForSpace`) like `get`/`list`/`head` already did. KV
    writes to a non-primary space (e.g. an `applications` space) are now possible
    from the CLI.
  - Binary KV values now round-trip byte-identically. `KVService.put` sends
    Blob/ArrayBuffer/typed-array/Buffer values as raw bytes
    (`application/octet-stream`, honoring an explicit `contentType`) instead of
    JSON-stringifying them into `{"type":"Buffer","data":[...]}`. A new
    `KVGetOptions.binary` returns the raw response bytes as a `Uint8Array`, and the
    CLI's `kv get -o <file>` / `--raw` use it so images and other binaries are
    written out unchanged.

## 2.3.0

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- 945f43c: Sign SQLite PRAGMA statements with the SQL admin capability so approved admin grants are used for PRAGMA requests.
- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.

## 2.3.0-beta.8

### Patch Changes

- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.

## 2.3.0-beta.7

### Patch Changes

- 945f43c: Sign SQLite PRAGMA statements with the SQL admin capability so approved admin grants are used for PRAGMA requests.

## 2.3.0-beta.6

### Minor Changes

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

## 2.3.0-beta.5

### Patch Changes

- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.

## 2.3.0-beta.2

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

## 2.2.1-beta.0

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.

## 2.2.0

### Minor Changes

- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.
- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.
- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

### Patch Changes

- 976b3c7: Deduplicate in-flight vault unlocks and reuse in-memory vault key material so repeated OpenKey-backed unlock paths do not trigger duplicate signer prompts.

## 2.2.0-beta.13

### Patch Changes

- 976b3c7: Deduplicate in-flight vault unlocks and reuse in-memory vault key material so repeated OpenKey-backed unlock paths do not trigger duplicate signer prompts.

## 2.2.0-beta.12

### Minor Changes

- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

## 2.2.0-beta.10

### Minor Changes

- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.

## 2.2.0-beta.7

### Minor Changes

- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.

## 2.1.0

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

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

## 2.1.0-beta.1

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

## 2.1.0-beta.0

### Minor Changes

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

## 2.0.3

## 2.0.2

### Patch Changes

- 7bb188f: Fix ESM compatibility by migrating sdk-core and sdk-services from tsc to tsup. Resolves extensionless import errors in Node's strict ESM resolver (e.g. Next.js instrumentation hooks).

## 2.0.1

### Patch Changes

- 75690db: Cache vault signatures in IndexedDB (encrypted with non-extractable AES-GCM CryptoKey) to eliminate repeated wallet popups on unlock. Skip identity signing entirely when public key already exists in public space. Add version-keyed signing constants (VaultVersionConfig) for forward-compatible key derivation. Gracefully no-ops in Node.js.

## 1.7.0

### Minor Changes

- 8649de8: Add `AUTH_UNAUTHORIZED` error code and 401 handling across all services. When the server returns 401 with "Unauthorized Action: {resource} / {ability}", the SDK now parses the response and returns a structured `AUTH_UNAUTHORIZED` error with `requiredAction` and `resource` in meta. Affects KV, SQL, and DuckDB services.
- 8649de8: Add storage quota error handling and TinyCloudQuota helper. New error codes `STORAGE_QUOTA_EXCEEDED` (402) and `STORAGE_LIMIT_REACHED` (413) with quota info parsing in KVService. New `TinyCloudQuota` class for querying quota status from the quota URL discovered via `/info`.

### Patch Changes

- def099d: Skip redundant public key writes on vault unlock and auto-include public-space KV delegation when creating delegations with KV actions. Remove unused VaultAction constants.

## 1.6.0

### Minor Changes

- db50ae4: Add DuckDB service to the TypeScript SDK. Provides `tc.duckdb` for querying and managing DuckDB databases on TinyCloud nodes, including `query()`, `queryArrow()`, `execute()`, `batch()`, `describe()`, `export()`, and `import()` operations. Named database handles via `tc.duckdb.database()`. SDK services are now conditionally initialized based on node feature detection — accessing an unsupported service throws `UnsupportedFeatureError`.

## 1.5.0

### Minor Changes

- 9d6b79f: Add vault.reencrypt() method as the preferred name for vault.grant(). The grant() method is now a deprecated alias that delegates to reencrypt(). Internal revoke() also uses reencrypt().

## 1.3.0

### Minor Changes

- 94ad509: Add Data Vault service for client-side encrypted KV storage with X25519 key exchange and AES-256-GCM encryption

## 1.2.0

### Minor Changes

- ca9b2c6: Add SQL service (tinycloud.sql/\*) with full TypeScript SDK support
  - New SQLService in sdk-services: query, execute, batch, executeStatement, export
  - DatabaseHandle for per-database operations
  - SQL re-exports in sdk-core with TinyCloud.sql getter
  - Node-SDK: SQL wiring in TinyCloudNode, DelegatedAccess, root delegation defaults
  - Fix type-only re-exports preventing bun runtime resolution

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
