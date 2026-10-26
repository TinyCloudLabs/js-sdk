# @tinycloudlabs/sdk-services

## 3.7.0

### Minor Changes

- c142537: Add a named encryption key client: key create, block and unblock, key descriptor reads, `ensureKey`, and key-scoped encrypt and decrypt. It is exposed under the `@tinycloud/sdk-services/encryption/named-keys` and `@tinycloud/node-sdk/encryption-keys` subpaths and is only used with nodes that advertise support.

  Details: TC-1777

- 4c3d073: Add a typed parser, builders and containment check for encryption key resources, the key ability constants, and a node feature check, under the `@tinycloud/sdk-services/encryption/resource` subpath.

  Details: TC-1777

- 279c8e9: `storage.full` now fires once per episode of the signed-in account's own storage being full, instead of re-arming on every status read. The episode ends only when a committing write succeeds on that account's own space (kv `put` and `batchPut`, vault `put`, and SQL and DuckDB write actions). A successful `delete` or `get`, or a committed write to another owner's space, does not end it, and `storage.status()` reporting room no longer re-arms the event. `StorageFullMonitor.rejection` reports the own episode only, and `clear()` (sign-out, sign-in as another account) ends it. Breaking for code that relied on a status read to re-arm `storage.full`: call a committing write to see the next event. Delegated owners each emit once until a status read or a successful committing write clears them.

  web-sdk panel: adds a storage section showing the account's usage and state (ok, nearly full, full, unlimited). While the own-storage episode is active the panel shows "Storage is full" and hides the numbers, even if status still reports room. The needs-permission state offers "Allow" only when the client can ask for authority; otherwise it shows the permission note with no action. The manage link uses the status `manageUrl` only when it is https and otherwise falls back to the SDK's storage manage URL.

  web-sdk host: while the own-storage episode is on, the button and panel show "Storage is full", and one info toast with a manage link is shown per episode, even with the panel closed. A new toast appears only after the episode ends and a new one starts. Each full delegated owner gets one info toast with the same copy. The toast reads the manage link from status at toast time, so each toast adds one status request. A toast whose status read finishes after its episode has ended is not shown. With `ui.toasts` off, no toast is shown and no status request is made.

  Details: TC-848

### Patch Changes

- 147bb78: Encryption network invocations are re-signed with the key of the session that built them, so a sign-in with a manifest creates the account encryption network. Decrypting for an account with no default encryption network reports that the account needs to sign in again with a current SDK.

  Details: TC-1910

## 3.7.0-beta.4

### Minor Changes

- c142537: Add a named encryption key client: key create, block and unblock, key descriptor reads, `ensureKey`, and key-scoped encrypt and decrypt. It is exposed under the `@tinycloud/sdk-services/encryption/named-keys` and `@tinycloud/node-sdk/encryption-keys` subpaths and is only used with nodes that advertise support.

  Details: TC-1777

- 4c3d073: Add a typed parser, builders and containment check for encryption key resources, the key ability constants, and a node feature check, under the `@tinycloud/sdk-services/encryption/resource` subpath.

  Details: TC-1777

## 3.7.0-beta.3

### Minor Changes

- 279c8e9: `storage.full` now fires once per episode of the signed-in account's own storage being full, instead of re-arming on every status read. The episode ends only when a committing write succeeds on that account's own space (kv `put` and `batchPut`, vault `put`, and SQL and DuckDB write actions). A successful `delete` or `get`, or a committed write to another owner's space, does not end it, and `storage.status()` reporting room no longer re-arms the event. `StorageFullMonitor.rejection` reports the own episode only, and `clear()` (sign-out, sign-in as another account) ends it. Breaking for code that relied on a status read to re-arm `storage.full`: call a committing write to see the next event. Delegated owners each emit once until a status read or a successful committing write clears them.

  web-sdk panel: adds a storage section showing the account's usage and state (ok, nearly full, full, unlimited). While the own-storage episode is active the panel shows "Storage is full" and hides the numbers, even if status still reports room. The needs-permission state offers "Allow" only when the client can ask for authority; otherwise it shows the permission note with no action. The manage link uses the status `manageUrl` only when it is https and otherwise falls back to the SDK's storage manage URL.

  web-sdk host: while the own-storage episode is on, the button and panel show "Storage is full", and one info toast with a manage link is shown per episode, even with the panel closed. A new toast appears only after the episode ends and a new one starts. Each full delegated owner gets one info toast with the same copy. The toast reads the manage link from status at toast time, so each toast adds one status request. A toast whose status read finishes after its episode has ended is not shown. With `ui.toasts` off, no toast is shown and no status request is made.

  Details: TC-848

## 3.7.0-beta.2

### Patch Changes

- 147bb78: Encryption network invocations are re-signed with the key of the session that built them, so a sign-in with a manifest creates the account encryption network. Decrypting for an account with no default encryption network reports that the account needs to sign in again with a current SDK.

  Details: TC-1910

## 3.6.1

## 3.6.0

### Patch Changes

- 82cbd43: A 413 from the SQL or DuckDB node is classified by side. A request rejected for size returns `SQL_REQUEST_TOO_LARGE` or `DUCKDB_REQUEST_TOO_LARGE`. A response that is too large keeps `SQL_RESPONSE_TOO_LARGE` or `DUCKDB_RESPONSE_TOO_LARGE`.

  Details: TC-1823

- dc61583: The replica workers import only the sdk-services modules they use, so the kv-storage and replica worker bundles no longer include the SQL, DuckDB, vault, and hooks services. Adds a `./context` subpath export to `@tinycloud/sdk-services`.

  Details: TC-1827

## 3.6.0-beta.3

### Patch Changes

- 82cbd43: A 413 from the SQL or DuckDB node is classified by side. A request rejected for size returns `SQL_REQUEST_TOO_LARGE` or `DUCKDB_REQUEST_TOO_LARGE`. A response that is too large keeps `SQL_RESPONSE_TOO_LARGE` or `DUCKDB_RESPONSE_TOO_LARGE`.

  Details: TC-1823

## 3.6.0-beta.2

### Patch Changes

- dc61583: The replica workers import only the sdk-services modules they use, so the kv-storage and replica worker bundles no longer include the SQL, DuckDB, vault, and hooks services. Adds a `./context` subpath export to `@tinycloud/sdk-services`.

  Details: TC-1827

## 3.5.0

### Minor Changes

- d60f81d: Add an opt-in, in-memory developer request log. With `requestLog: true` in `TinyCloudNode` config, the log records requests the SDK makes on your behalf: operation, path (first segment only), space (the name after the last colon), host, size, duration, attempts, result and source. Read them from `node.requests`, a read-only view with `snapshot()`, `subscribe()` and `onClear()`. The log keeps the most recent 500 entries and is cleared on sign-out, on sign-in as another account, and when a session is restored for a different owner. Entries carry sizes only; body and header content is absent from them. When the option is omitted, no log is created and no events are built.

  Details: TC-848

## 3.5.0-beta.0

### Minor Changes

- d60f81d: Add an opt-in, in-memory developer request log. With `requestLog: true` in `TinyCloudNode` config, the log records requests the SDK makes on your behalf: operation, path (first segment only), space (the name after the last colon), host, size, duration, attempts, result and source. Read them from `node.requests`, a read-only view with `snapshot()`, `subscribe()` and `onClear()`. The log keeps the most recent 500 entries and is cleared on sign-out, on sign-in as another account, and when a session is restored for a different owner. Entries carry sizes only; body and header content is absent from them. When the option is omitted, no log is created and no events are built.

  Details: TC-848

## 3.3.2

## 3.3.1

## 3.3.0

### Minor Changes

- 87a137e: Retry node `NODE_BUSY` and `REQUEST_TIMEOUT` answers automatically. Both mean nothing was applied, so the services now retry them under the existing `retryPolicy` through the new `ServiceContext.invokeWithRetry(url, build)`, which calls `build` once per attempt so every attempt carries a freshly signed invocation (the node answers a repeated invocation with 409, so re-sending one could never succeed). `ServiceContext.fetch` itself no longer retries. A context without `invokeWithRetry` sends once. The policy: at most 4 attempts in about 12 s, honouring the node's `Retry-After` (capped at the remaining budget) and otherwise backing off exponentially with full jitter (250 ms base, 4 s cap). Aborts and per-request timeouts end the wait at once, and `OUTCOME_UNKNOWN` is never retried. `defaultRetryPolicy` changes accordingly (its retryable codes are now `NODE_BUSY` and `REQUEST_TIMEOUT`; `NETWORK_ERROR` and `TIMEOUT` are no longer listed because no service read them), and `RetryPolicy` gains an optional `maxTotalMs`. Opt out with `retryPolicy: { maxAttempts: 1 }`.

  The CLI gains `--no-retry` and `TINYCLOUD_RETRY=0` for monitors and probes that must see the node's honest `NODE_BUSY`. KV responses (and `tc kv get|put|delete --json`) report `attempts` and `backoffMs`.

- 0c4c6b2: `ProfileReplicaPurge.deny` with `{ deferErase: true }` now accepts only `reason: "sign_out"` and returns `ProfileReplicaDeferredDenyOutcome`, whose committed `denied` always carries `resumeToken`. `ReplicaEraseReport.deferred: true` marks a pass held by a deferred denial, so `remaining: 0` there is not completion. node-sdk exports the full contract `ProfileReplicaPurge`, requires the displayed `approval` in `prepareLogoutPending`, and reports `purgePending` from inspected status while a deferred denial or any intent remains.

  A v1 logout marker records the epoch its denial actually committed (`deniedEpoch`) in the same locked section as the deny, and every later check compares with it. A sign-out interrupted between its deny floor and gate writes is completed by the next `auth logout` (`@tinycloud/replica/profile-gate` adds `readLogoutGate`, `advanceInactiveGate` and `REPLICA_DENY_FLOOR_FILE`); reads report "a previous sign-out was interrupted; re-running `tc auth logout` completes it". A restored older gate under a recorded denial refuses with the `tc profile delete` route.

  `auth logout` by an account other than the one whose replicas the profile holds writes no marker and leaves that account's gate, floor and replicas untouched: it signs out, removes its own session and key, and erases the profile's legacy `replicas/` mirror (replayed at startup after a crash). `--revoke` there revokes only grants on the signed-in account's spaces.

  When startup recovery refuses a pending logout because a credential file is unreadable, the message now names that file (`session.json` or `profile.json`).

  CLI-bound storage and purge name the CLI's `replication/events.jsonl` and `events.jsonl.1` diagnostics logs (`diagnosticFiles`). With a readable gate, those exact names count as known only while they are regular files, so a fully synced profile signs out without `--discard-local-changes`; a symlink there stays unknown.

- 2292db7: Vault compare-and-swap and opt-in address binding (TC-1432). Everything is additive; existing reads and writes behave as before.
  - `VaultEntry.etag`: the node's strong ETag of the stored envelope. `readNetworkEncrypted` always returns it; `vault.get` returns it only with `source: "network"`, never from a replica (a replica can serve a stale etag). Network-encrypted vaults only.
  - `VaultPutOptions.ifMatch`: write only while the stored envelope still has that etag, passed exactly as read (quotes included); it cannot be combined with `ifNoneMatch`. A failed `ifMatch` write has its own code instead of `STORAGE_ERROR`: `ETAG_MISMATCH` (412, including a deleted or never-written key; re-read and retry), `INVALID_ETAG` (a weak, unquoted or otherwise malformed etag, refused locally or by the node's 400; never retry), `OUTCOME_UNKNOWN` (500 `outcome_unknown`, or a connection that failed with no response: the write may have been applied, so re-read before retrying and sign a fresh request) and `NODE_BUSY` (503, nothing written). Writes without `ifMatch` keep their current error mapping. `readSecret` maps the new `aad_mismatch` status to `read_failed`.
  - `VaultGetOptions.expectAad` (default off): refuse an envelope whose AAD is not `tinycloud.vault:<spaceId>:<key>` for the vault's own space and key. The space id is compared after lowercasing its EVM addresses, so a checksummed and a lowercase spelling are the same space. A mismatch, including an envelope written with no AAD, fails with `AAD_MISMATCH` (`get`) or `{ status: "aad_mismatch" }` (`readNetworkEncrypted`) before any decrypt request. This rejects a ciphertext copied to another key; it does not stop a freshly encrypted forgery. `getShared` is unchanged.

### Patch Changes

- a7cdfe0: sdk-services adds the Node/CLI profile-facade contract types for deferred revoke and exact-inventory logout markers: `ProfileReplicaPurge`, `ProfileReplicaLogoutPending` (with a v1 `deniedEpoch`), `ProfileReplicaRemoteLogoutState`, `ProfileReplicaPreflight` and the inventory identity types. A new `typecheck:contract` script compiles their type assertions. CONTRACT.md specifies the logout behaviour the CLI logout implementation will deliver, including deny-first ordering, completion of an interrupted denial and the two-command inventory approval. This release ships types and specification only; no runtime behaviour changes, and browser lifecycle contracts are unchanged.

  node-sdk's `ProfileReplicaPurge` and `ProfileReplicaDeferredToken` are now derived from those contract types (the subset node-sdk implements), with the same shape as before.

- 94566db: Replication: enforce independently verified finite-expiration owner SIWE anchors with uncaveated KV get+sync coverage on the same verified scope in the exact space, bounded device-grant minting, and session-parent-only silent renewal. A `first_install` timestamp bounds expiry only; it cannot authorize minting. The controller uses the durable browser consent deadline for preflight, active timers, grant caps, and network fallback; compact restored sessions can only reuse a matching stamped, active installed grant with finite effective expiry while their current independently verified session still covers the requested prefix. A missing owner-backed compact proof fails closed, and session refusal never exposes installed local bytes or keys. Grant transitions use opaque replica IDs, including when a committed gate expiry beats the controller timer. The runtime subscribes only while its stamped controller is bound and detaches on rebind or close. Adds pure grant-lifetime policy helpers and validates `replication.grantTtlMs` (positive, at most 7 days).

  Browser boot bounds replica recovery before constructing the node. Failed or timed-out recovery gates local admission without breaking the network session; explicit sign-out still reaches the real lifecycle denial. The root web bundle remains inert with replication off; `@tinycloud/web-sdk/replica` exports a pure optional plugin and async IndexedDB factory loader. Applications register that plugin once with root `registerBrowserReplica` before constructing an enabled client, so test fixtures can inject a scheduler into the same root-owned runtime registry without a public clock option.

  Browser sign-in selects the connected wallet's persisted session. Explicit restore retains valid network authority for a different or unknown wallet, but refuses replica stamp admission; local reads recheck the provider account before returning cached bytes or keys.

  The runtime binds pending writes to the supplied lifecycle stamp and creates a fresh pending store when the stamp changes; gated storage cannot fall back to volatile pending memory. Replica opens carry the configured quota alongside the stamped grant policy. When a shorter grant policy expires before the immutable seven-day gate, get/list use the network and report `GRANT_EXPIRED`; only gate expiry causes `CONSENT_EXPIRED` and scoped denial. Rejected offline network fallbacks retain their network error and emit one `replication.read` error with the gate or current-session refusal reason; no local bytes are returned.

- 94566db: Expose a post-commit browser consent-expiry subscription for bound replication controllers. Recover expired origin keys before a direct replica open so a browser closed at the deadline cannot serve local data on return. Keep the web bundle replica-free by importing grant TTL policy from the narrow policy entry.
- 9891ed9: Replication: add the shared replica contract for browser and node/CLI storage adapters: the lifecycle gate (`ReplicaGateTx.run`, session stamps, scoped deny), the grant-lifetime policy, the quota seams, the options `grantTtlMs`, `maxBytes` and `minFreeBytes`, and new status fields and events. It adds `@tinycloud/sdk-services/kv/replication/contractConstants`, `/grantPolicyConstants` (numeric policy constants only, with the original names re-exported from `/contractConstants`) and `/grantPolicyTypes`. Diagnostics allowlists, `TelemetryEvents` and CLI debug output cover the new values.

  Source-breaking for exhaustive consumers (replication is beta): switches over these types must now handle `ReplicaState` `gated`, `ReplicationReason` `replica_gated`, the `replication.grant` and `replication.lifecycle` events, sync `trigger: "peer"` and sync `class: "lifecycle"`. Browser ungated `inspectStatus` now returns a discriminated `ReplicaInspectedStatus { redacted: true }` branch without grant, authority or errors; consumers must narrow before reading those fields. Browser `admitPage` takes the exact signed ciphertext-row `deltaBytes` instead of plaintext `blobBytes`/entry count; node's admission hook retains its existing shape.

  `ReplicaGateAccess` now carries a prederived `principalHash` instead of a raw principal; browser `run` requires gate/account key IDs and derives hashes outside IDB transactions. `ReplicaBrowserGateTx` returns a typed private-key snapshot for this derivation, and `ReplicaGatedStorage.open` no longer inherits the unstamped Phase 1 overload. Browser partition-index entries add private-HMAC `lookupId` and nonsecret `ownerDevice` for owner status and scoped purge without decrypting the sealed owner device.

  Phase 2 `ReplicaGatedHandle` requires the opaque `replicaId` supplied by the adapter. Consent-deadline grant events are emitted only for already opened handles with that id; pre-open expiry is reported by lifecycle/recovery, never a raw-prefix or unsalted identifier. `ReplicaLifecycleGate.consentDeadline(stamp)` exposes only the immutable persisted deadline to the main-thread timer, including compact session restore without a fresh anchor; it never derives one from first install.

  The browser contract also defines the origin-wide deny tombstone outside the deletable IndexedDB database, its fail-closed gate semantics, and the lock requirement across lifecycle mutations.

  Browser schema v2 destructively replaces legacy plaintext replica-owned v1 stores only after preserving the origin denial floor; pre-v2 persisted stamps cannot restore. The RC1 per-partition databases remain untouched.

  Establishment takes `{ consentAnchor }`, not `{ siweIssuedAt }`: validated signed SIWE or an independently verified **owner-authorizing** delegation proof supplies finite recency, never a new child minted from old consent. With only a compact leaf or no owner proof timestamp, establishment refuses `not_established` and KV uses the network; matching persisted stamps may restore. Node `pending.json` operations require the profile lock across gate check and file access; deny records a durable identity generation with the pending intent. `activationAllowed` returns false for a null gate principal. Browser replica identifiers use private nonextractable gate-HMAC keys, and account KV metadata/content is sealed with separate account keys; denial or seven-day consent expiry shreds both key records before purge. This limits replica-owned storage plaintext but does not claim confidentiality against a raw browser-profile reader with a valid signed-in session (CONTRACT.md).

  Replica consent from full SIWE requires verified signed `issuedAt`, finite signed `expirationTime` and an exact-space uncaveated KV get+sync witness. Expirationless or otherwise unanchored SIWE can remain network-valid but cannot establish, mint or renew a replica; refused stamps never fail network sign-in/restore, and restore never establishes. A same-principal fresh SIWE does not extend the persisted deadline: controller mint and adapter effective expiry are capped by the gate's durable deadline.

  The browser origin-wide encoded-row budget includes a reserved device bucket for sealed owner-device and grant/first-install rows, admitted with partition rows before any put and released on deny. Native CryptoKey serialization and IndexedDB allocation remain unobservable; node admission is unchanged.

  Compact `sessionOnly` restore requires both a matching stamp/active installed grant **and the current session's own uncaveated get authority** for the requested key or list prefix. A `sessionGrant` refusal cannot be overridden by a stored device grant; compact sessions never mint or renew. Plain logout still ends the network session, while `logout --revoke` keeps it if online revocation fails and leaves the replica denied for retry.

  Browser erase retains a keyless opaque/numeric `purged: true` meta tombstone to fence stale handles. Its measured bytes remain charged until deletion or same-partition replacement; replay releases zero and cannot double-subtract quota.

- 370a8e4: `TinyCloudWeb.signOut()` now ends the session on the instance, through the new `TinyCloudNode.signOut()`: session accessors return `undefined`, the session key is replaced, pending requests are aborted, and service calls fail instead of acting for the signed-out user. A sign-in or restore still in progress when sign-out is called does not establish its session; a later `signIn()` or `restoreSession()` starts a fresh one.

  `useDelegation()` results now belong to the session that created them: they stop working when that session signs out or is replaced by another `signIn()` or `restoreSession()`.

- ef49c14: The "Manage storage" link in storage-full errors and status now points to https://account.tinycloud.xyz/storage instead of /billing. The `tinycloud account billing` commands still open the billing page.

  Details: TC-848

- 90bc0ae: Report the node's retry signals (tinycloud-node #347) as typed errors instead of `NETWORK_ERROR`, for SQL, DuckDB and KV get, head, list, put and delete.
  - `NODE_BUSY`: `503 sql_busy:<stage>` or `unavailable_retryable`. Nothing was applied. `meta.stage` (`lock_wait`, `hydration`, `artifact_transfer` or `identity_resolution`) when the node names one.
  - `REQUEST_TIMEOUT`: `503 request_timeout`. The node's deadline passed before any write began, so nothing was applied.
  - `OUTCOME_UNKNOWN`: `500 outcome_unknown`. A write may have been applied; read it back before retrying a non-idempotent operation.

  `meta.retryable` says whether a retry is safe and `meta.retryAfterMs` carries the node's `Retry-After`. The SDK still never retries by itself. A response without these bodies, such as a 503 or 500 from node 1.20.6, keeps its old code, and real transport failures stay `NETWORK_ERROR`. New export: `nodeRetryError`.

  Fix: a conditional KV `put` or `delete` that got a 503 was reported as `KV_CONFLICT`. A 503 is never a conflict; the node's precondition failure is its 412, still `KV_PRECONDITION_FAILED`. The SDK no longer produces `KV_CONFLICT` itself (callers that handle it keep working). A conditional write's 503 is now `NODE_BUSY` or `REQUEST_TIMEOUT` with the typed body, otherwise `KV_WRITE_FAILED` (put) or `NETWORK_ERROR` (delete) with `meta.status` 503.

  `tc` prints a plain message for the new codes ("The node is busy, try again in 5 s.", "Outcome unknown: the node may have applied the write. Check before retrying.") and exits 7.

## 3.3.0-beta.39

### Patch Changes

- ef49c14: The "Manage storage" link in storage-full errors and status now points to https://account.tinycloud.xyz/storage instead of /billing. The `tinycloud account billing` commands still open the billing page.

  Details: TC-848

## 3.3.0-beta.25

### Minor Changes

- 87a137e: Retry node `NODE_BUSY` and `REQUEST_TIMEOUT` answers automatically. Both mean nothing was applied, so the services now retry them under the existing `retryPolicy` through the new `ServiceContext.invokeWithRetry(url, build)`, which calls `build` once per attempt so every attempt carries a freshly signed invocation (the node answers a repeated invocation with 409, so re-sending one could never succeed). `ServiceContext.fetch` itself no longer retries. A context without `invokeWithRetry` sends once. The policy: at most 4 attempts in about 12 s, honouring the node's `Retry-After` (capped at the remaining budget) and otherwise backing off exponentially with full jitter (250 ms base, 4 s cap). Aborts and per-request timeouts end the wait at once, and `OUTCOME_UNKNOWN` is never retried. `defaultRetryPolicy` changes accordingly (its retryable codes are now `NODE_BUSY` and `REQUEST_TIMEOUT`; `NETWORK_ERROR` and `TIMEOUT` are no longer listed because no service read them), and `RetryPolicy` gains an optional `maxTotalMs`. Opt out with `retryPolicy: { maxAttempts: 1 }`.

  The CLI gains `--no-retry` and `TINYCLOUD_RETRY=0` for monitors and probes that must see the node's honest `NODE_BUSY`. KV responses (and `tc kv get|put|delete --json`) report `attempts` and `backoffMs`.

## 3.3.0-beta.11

### Minor Changes

- 2292db7: Vault compare-and-swap and opt-in address binding (TC-1432). Everything is additive; existing reads and writes behave as before.
  - `VaultEntry.etag`: the node's strong ETag of the stored envelope. `readNetworkEncrypted` always returns it; `vault.get` returns it only with `source: "network"`, never from a replica (a replica can serve a stale etag). Network-encrypted vaults only.
  - `VaultPutOptions.ifMatch`: write only while the stored envelope still has that etag, passed exactly as read (quotes included); it cannot be combined with `ifNoneMatch`. A failed `ifMatch` write has its own code instead of `STORAGE_ERROR`: `ETAG_MISMATCH` (412, including a deleted or never-written key; re-read and retry), `INVALID_ETAG` (a weak, unquoted or otherwise malformed etag, refused locally or by the node's 400; never retry), `OUTCOME_UNKNOWN` (500 `outcome_unknown`, or a connection that failed with no response: the write may have been applied, so re-read before retrying and sign a fresh request) and `NODE_BUSY` (503, nothing written). Writes without `ifMatch` keep their current error mapping. `readSecret` maps the new `aad_mismatch` status to `read_failed`.
  - `VaultGetOptions.expectAad` (default off): refuse an envelope whose AAD is not `tinycloud.vault:<spaceId>:<key>` for the vault's own space and key. The space id is compared after lowercasing its EVM addresses, so a checksummed and a lowercase spelling are the same space. A mismatch, including an envelope written with no AAD, fails with `AAD_MISMATCH` (`get`) or `{ status: "aad_mismatch" }` (`readNetworkEncrypted`) before any decrypt request. This rejects a ciphertext copied to another key; it does not stop a freshly encrypted forgery. `getShared` is unchanged.

## 3.3.0-beta.7

### Minor Changes

- 0c4c6b2: `ProfileReplicaPurge.deny` with `{ deferErase: true }` now accepts only `reason: "sign_out"` and returns `ProfileReplicaDeferredDenyOutcome`, whose committed `denied` always carries `resumeToken`. `ReplicaEraseReport.deferred: true` marks a pass held by a deferred denial, so `remaining: 0` there is not completion. node-sdk exports the full contract `ProfileReplicaPurge`, requires the displayed `approval` in `prepareLogoutPending`, and reports `purgePending` from inspected status while a deferred denial or any intent remains.

  A v1 logout marker records the epoch its denial actually committed (`deniedEpoch`) in the same locked section as the deny, and every later check compares with it. A sign-out interrupted between its deny floor and gate writes is completed by the next `auth logout` (`@tinycloud/replica/profile-gate` adds `readLogoutGate`, `advanceInactiveGate` and `REPLICA_DENY_FLOOR_FILE`); reads report "a previous sign-out was interrupted; re-running `tc auth logout` completes it". A restored older gate under a recorded denial refuses with the `tc profile delete` route.

  `auth logout` by an account other than the one whose replicas the profile holds writes no marker and leaves that account's gate, floor and replicas untouched: it signs out, removes its own session and key, and erases the profile's legacy `replicas/` mirror (replayed at startup after a crash). `--revoke` there revokes only grants on the signed-in account's spaces.

  When startup recovery refuses a pending logout because a credential file is unreadable, the message now names that file (`session.json` or `profile.json`).

  CLI-bound storage and purge name the CLI's `replication/events.jsonl` and `events.jsonl.1` diagnostics logs (`diagnosticFiles`). With a readable gate, those exact names count as known only while they are regular files, so a fully synced profile signs out without `--discard-local-changes`; a symlink there stays unknown.

### Patch Changes

- a7cdfe0: sdk-services adds the Node/CLI profile-facade contract types for deferred revoke and exact-inventory logout markers: `ProfileReplicaPurge`, `ProfileReplicaLogoutPending` (with a v1 `deniedEpoch`), `ProfileReplicaRemoteLogoutState`, `ProfileReplicaPreflight` and the inventory identity types. A new `typecheck:contract` script compiles their type assertions. CONTRACT.md specifies the logout behaviour the CLI logout implementation will deliver, including deny-first ordering, completion of an interrupted denial and the two-command inventory approval. This release ships types and specification only; no runtime behaviour changes, and browser lifecycle contracts are unchanged.

  node-sdk's `ProfileReplicaPurge` and `ProfileReplicaDeferredToken` are now derived from those contract types (the subset node-sdk implements), with the same shape as before.

- 94566db: Replication: enforce independently verified finite-expiration owner SIWE anchors with uncaveated KV get+sync coverage on the same verified scope in the exact space, bounded device-grant minting, and session-parent-only silent renewal. A `first_install` timestamp bounds expiry only; it cannot authorize minting. The controller uses the durable browser consent deadline for preflight, active timers, grant caps, and network fallback; compact restored sessions can only reuse a matching stamped, active installed grant with finite effective expiry while their current independently verified session still covers the requested prefix. A missing owner-backed compact proof fails closed, and session refusal never exposes installed local bytes or keys. Grant transitions use opaque replica IDs, including when a committed gate expiry beats the controller timer. The runtime subscribes only while its stamped controller is bound and detaches on rebind or close. Adds pure grant-lifetime policy helpers and validates `replication.grantTtlMs` (positive, at most 7 days).

  Browser boot bounds replica recovery before constructing the node. Failed or timed-out recovery gates local admission without breaking the network session; explicit sign-out still reaches the real lifecycle denial. The root web bundle remains inert with replication off; `@tinycloud/web-sdk/replica` exports a pure optional plugin and async IndexedDB factory loader. Applications register that plugin once with root `registerBrowserReplica` before constructing an enabled client, so test fixtures can inject a scheduler into the same root-owned runtime registry without a public clock option.

  Browser sign-in selects the connected wallet's persisted session. Explicit restore retains valid network authority for a different or unknown wallet, but refuses replica stamp admission; local reads recheck the provider account before returning cached bytes or keys.

  The runtime binds pending writes to the supplied lifecycle stamp and creates a fresh pending store when the stamp changes; gated storage cannot fall back to volatile pending memory. Replica opens carry the configured quota alongside the stamped grant policy. When a shorter grant policy expires before the immutable seven-day gate, get/list use the network and report `GRANT_EXPIRED`; only gate expiry causes `CONSENT_EXPIRED` and scoped denial. Rejected offline network fallbacks retain their network error and emit one `replication.read` error with the gate or current-session refusal reason; no local bytes are returned.

- 94566db: Expose a post-commit browser consent-expiry subscription for bound replication controllers. Recover expired origin keys before a direct replica open so a browser closed at the deadline cannot serve local data on return. Keep the web bundle replica-free by importing grant TTL policy from the narrow policy entry.
- 90bc0ae: Report the node's retry signals (tinycloud-node #347) as typed errors instead of `NETWORK_ERROR`, for SQL, DuckDB and KV get, head, list, put and delete.
  - `NODE_BUSY`: `503 sql_busy:<stage>` or `unavailable_retryable`. Nothing was applied. `meta.stage` (`lock_wait`, `hydration`, `artifact_transfer` or `identity_resolution`) when the node names one.
  - `REQUEST_TIMEOUT`: `503 request_timeout`. The node's deadline passed before any write began, so nothing was applied.
  - `OUTCOME_UNKNOWN`: `500 outcome_unknown`. A write may have been applied; read it back before retrying a non-idempotent operation.

  `meta.retryable` says whether a retry is safe and `meta.retryAfterMs` carries the node's `Retry-After`. The SDK still never retries by itself. A response without these bodies, such as a 503 or 500 from node 1.20.6, keeps its old code, and real transport failures stay `NETWORK_ERROR`. New export: `nodeRetryError`.

  Fix: a conditional KV `put` or `delete` that got a 503 was reported as `KV_CONFLICT`. A 503 is never a conflict; the node's precondition failure is its 412, still `KV_PRECONDITION_FAILED`. The SDK no longer produces `KV_CONFLICT` itself (callers that handle it keep working). A conditional write's 503 is now `NODE_BUSY` or `REQUEST_TIMEOUT` with the typed body, otherwise `KV_WRITE_FAILED` (put) or `NETWORK_ERROR` (delete) with `meta.status` 503.

  `tc` prints a plain message for the new codes ("The node is busy, try again in 5 s.", "Outcome unknown: the node may have applied the write. Check before retrying.") and exits 7.

## 3.2.6-beta.4

### Patch Changes

- 9891ed9: Replication: add the shared replica contract for browser and node/CLI storage adapters: the lifecycle gate (`ReplicaGateTx.run`, session stamps, scoped deny), the grant-lifetime policy, the quota seams, the options `grantTtlMs`, `maxBytes` and `minFreeBytes`, and new status fields and events. It adds `@tinycloud/sdk-services/kv/replication/contractConstants`, `/grantPolicyConstants` (numeric policy constants only, with the original names re-exported from `/contractConstants`) and `/grantPolicyTypes`. Diagnostics allowlists, `TelemetryEvents` and CLI debug output cover the new values.

  Source-breaking for exhaustive consumers (replication is beta): switches over these types must now handle `ReplicaState` `gated`, `ReplicationReason` `replica_gated`, the `replication.grant` and `replication.lifecycle` events, sync `trigger: "peer"` and sync `class: "lifecycle"`. Browser ungated `inspectStatus` now returns a discriminated `ReplicaInspectedStatus { redacted: true }` branch without grant, authority or errors; consumers must narrow before reading those fields. Browser `admitPage` takes the exact signed ciphertext-row `deltaBytes` instead of plaintext `blobBytes`/entry count; node's admission hook retains its existing shape.

  `ReplicaGateAccess` now carries a prederived `principalHash` instead of a raw principal; browser `run` requires gate/account key IDs and derives hashes outside IDB transactions. `ReplicaBrowserGateTx` returns a typed private-key snapshot for this derivation, and `ReplicaGatedStorage.open` no longer inherits the unstamped Phase 1 overload. Browser partition-index entries add private-HMAC `lookupId` and nonsecret `ownerDevice` for owner status and scoped purge without decrypting the sealed owner device.

  Phase 2 `ReplicaGatedHandle` requires the opaque `replicaId` supplied by the adapter. Consent-deadline grant events are emitted only for already opened handles with that id; pre-open expiry is reported by lifecycle/recovery, never a raw-prefix or unsalted identifier. `ReplicaLifecycleGate.consentDeadline(stamp)` exposes only the immutable persisted deadline to the main-thread timer, including compact session restore without a fresh anchor; it never derives one from first install.

  The browser contract also defines the origin-wide deny tombstone outside the deletable IndexedDB database, its fail-closed gate semantics, and the lock requirement across lifecycle mutations.

  Browser schema v2 destructively replaces legacy plaintext replica-owned v1 stores only after preserving the origin denial floor; pre-v2 persisted stamps cannot restore. The RC1 per-partition databases remain untouched.

  Establishment takes `{ consentAnchor }`, not `{ siweIssuedAt }`: validated signed SIWE or an independently verified **owner-authorizing** delegation proof supplies finite recency, never a new child minted from old consent. With only a compact leaf or no owner proof timestamp, establishment refuses `not_established` and KV uses the network; matching persisted stamps may restore. Node `pending.json` operations require the profile lock across gate check and file access; deny records a durable identity generation with the pending intent. `activationAllowed` returns false for a null gate principal. Browser replica identifiers use private nonextractable gate-HMAC keys, and account KV metadata/content is sealed with separate account keys; denial or seven-day consent expiry shreds both key records before purge. This limits replica-owned storage plaintext but does not claim confidentiality against a raw browser-profile reader with a valid signed-in session (CONTRACT.md).

  Replica consent from full SIWE requires verified signed `issuedAt`, finite signed `expirationTime` and an exact-space uncaveated KV get+sync witness. Expirationless or otherwise unanchored SIWE can remain network-valid but cannot establish, mint or renew a replica; refused stamps never fail network sign-in/restore, and restore never establishes. A same-principal fresh SIWE does not extend the persisted deadline: controller mint and adapter effective expiry are capped by the gate's durable deadline.

  The browser origin-wide encoded-row budget includes a reserved device bucket for sealed owner-device and grant/first-install rows, admitted with partition rows before any put and released on deny. Native CryptoKey serialization and IndexedDB allocation remain unobservable; node admission is unchanged.

  Compact `sessionOnly` restore requires both a matching stamp/active installed grant **and the current session's own uncaveated get authority** for the requested key or list prefix. A `sessionGrant` refusal cannot be overridden by a stored device grant; compact sessions never mint or renew. Plain logout still ends the network session, while `logout --revoke` keeps it if online revocation fails and leaves the replica denied for retry.

  Browser erase retains a keyless opaque/numeric `purged: true` meta tombstone to fence stale handles. Its measured bytes remain charged until deletion or same-partition replacement; replay releases zero and cannot double-subtract quota.

## 3.2.6-beta.2

### Patch Changes

- 370a8e4: `TinyCloudWeb.signOut()` now ends the session on the instance, through the new `TinyCloudNode.signOut()`: session accessors return `undefined`, the session key is replaced, pending requests are aborted, and service calls fail instead of acting for the signed-out user. A sign-in or restore still in progress when sign-out is called does not establish its session; a later `signIn()` or `restoreSession()` starts a fresh one.

  `useDelegation()` results now belong to the session that created them: they stop working when that session signs out or is replaced by another `signIn()` or `restoreSession()`.

## 3.2.5

### Patch Changes

- 0b02662: Probe for the SQL migrations table before reading applied IDs so first sign-in on a fresh database avoids a failing request while up-to-date databases remain read-only.

## 3.2.5-beta.0

### Patch Changes

- 0b02662: Probe for the SQL migrations table before reading applied IDs so first sign-in on a fresh database avoids a failing request while up-to-date databases remain read-only.

## 3.2.4

## 3.2.3

## 3.2.2

## 3.2.1

## 3.2.0

### Minor Changes

- 26f86bd: TC-628: Storage status, one `storage.full` event, and no doomed writes on read paths.
  - Storage rejections read the node's JSON 402/413 body. `meta.usedBytes`/`meta.limitBytes` still describe the space, and `meta.account` carries `{ usedBytes, limitBytes, plan }` for the whole account when the node sends it. The old plain-text body still parses. SQL and DuckDB now report a storage 413 (the node's `storage_limit_reached` body or storage text) as `STORAGE_LIMIT_REACHED`, as KV already did; a 413 without it stays `*_RESPONSE_TOO_LARGE`.
  - `tc.on("storage.full", handler)` on `TinyCloudNode` and `TinyCloudWeb` fires once, on the first write any service has rejected for storage. The event carries the code, the space numbers, `account` and the rejected `spaceId`. It also goes through the service context's `emit` as `storage.full` (`TelemetryEvents.STORAGE_FULL`). Which owners are full is recorded per owner, so a full delegated space never hides that the signed-in account is full too. It fires again once `storage.status()` has reported room for every owner whose write was rejected, or after signing in or restoring a session whose primary space belongs to a different owner. Restoring the same owner with or without the optional address/SIWE metadata keeps the episode.
  - `tc.storage.status({ space? })` reads usage and plan from the node (`tinycloud.space/info`, TC-626) and returns `{ usedBytes, limitBytes, account, plan, state, manageUrl }`. `state` is `ok`, `nearly_full` (≥ 90%) or `full`, from the account totals when known, and `limitBytes: null` means unlimited. It needs `tinycloud.space/info` on that space, from the session recap or an installed runtime delegation. Default sessions do not request it yet. When the grant cannot be confirmed locally, it returns `PERMISSION_DENIED` and sends no request. A node without the usage read returns the new `STORAGE_STATUS_UNAVAILABLE` code.
  - While the signed-in account's storage is known full:
    - `spaces.list()` still lists, but does not register each listed space;
    - sign-in skips the bootstrap repair (`bootstrapStatus.reason: "storage-full"`);
    - sign-in skips the background account registry sync (index ensure, manifest records, space sync).

    These writes would only be refused again. A rejection on another owner's space does not stop them, and does not hide a later rejection on the account's own.

  - `SpaceServiceConfig` (and `SpaceServiceConfigSchema`) accepts `isStorageFull?: () => boolean`; when it returns true, `list()` skips `onSpaceRegistered`.
  - New exports:
    - functions and values: `parseStorageRejection`, `parseStorageStatus`, `storageUsageState`, `StorageFullMonitor` (per-owner: `isFullFor(spaceId)`, `clearFor(spaceId)`), `STORAGE_MANAGE_URL`, `STORAGE_NEARLY_FULL_RATIO`, and the error code `ErrorCodes.STORAGE_STATUS_UNAVAILABLE`;
    - types: `StorageStatus`, `StorageStatusOptions`, `StorageUsage`, `StorageUsageState`, `IStorageService`, `StorageFullEvent`, `StorageFullHandler`, `StorageAccountUsage` and `StorageRejectionDetails`.
  - Deprecated, still exported unchanged: `TinyCloudQuota`, `QuotaConfig`, `QuotaStatus` and `StorageQuotaInfo`. Use `storage.status()` and `on("storage.full")` instead.

- 4f851e6: Create-only secret writes, app-derived secret scopes, typed vault write errors, and classified delegation activation failures.
  - **New:** `appSecretScope(appId)` derives the canonical secret scope for an app id (`com.listen.app` → `com-listen-app`), with `SECRET_SCOPE_RE`, `MAX_SECRET_SCOPE_LENGTH` (64) and `TC832_RESERVED_SCOPES` exported from every SDK package.
  - **New:** `secrets.put(name, value, { ifAbsent: true })` (type `SecretPutOptions`) writes only when the secret does not exist. An existing secret fails with vault error `ALREADY_EXISTS` (KV 412; `meta.status` and the typed KV error as `cause`) and is never overwritten. `DataVaultService.put` accepts `{ ifNoneMatch: "*" }` for network-encrypted vaults; a legacy (key-blob) vault refuses it with `STORAGE_ERROR` before any KV call. The Node and Web secrets wrappers forward the option unchanged.
  - **New:** a refused vault write keeps its authorization classification. A refused write is `AUTH_UNAUTHORIZED` only for HTTP 401 (sign-in needed). A 403 is `PERMISSION_DENIED`. Both keep `meta.status` and the typed KV error as `cause`, so `validatedCapabilityOf` still finds the missing capability. Other failures stay `STORAGE_ERROR`, now with `meta` and the KV error chained as the cause.
  - **Fix:** KV `get`/`head`/`delete` now honour their timeout and abort signal while reading a 404 body that never finishes, instead of hanging; `createSignedReadUrl` error bodies get the same fix.
  - **New:** node-sdk classifies delegation activation failures. `useRuntimeDelegation` reports an unreachable host as an error with `code: "ACTIVATION_TRANSPORT_FAILED"`. `RuntimeDelegationRejection` gains `activation_unavailable` (transport failure, 408, 429, 5xx) and `activation_unauthenticated` (401); every other activation failure stays `activation_rejected`.

  **Breaks:**
  - Code that matched `STORAGE_ERROR` for a vault or secrets write refused by authorization now receives `AUTH_UNAUTHORIZED` (401) or `PERMISSION_DENIED` (403, or no status).
  - `VaultError`/`VaultErrorInput` gain the `ALREADY_EXISTS`, `AUTH_UNAUTHORIZED` and `PERMISSION_DENIED` variants, so exhaustive `switch`es over the vault error code need the new cases.
  - Code that enumerates `RuntimeDelegationRejection` / `RUNTIME_DELEGATION_REJECTIONS` sees two new reasons; activation failures that were `activation_rejected` may now be `activation_unavailable` or `activation_unauthenticated`.

- df18325: Add the Phase 1 replication contract, canonical identity and scope helpers, network-only KV read option, and nullable KVService read-through seam. With the seam unset, KV operations retain their existing network behavior. Pending-write stores declare whether their committed epoch and records survive restarts; for non-durable stores, controllers must require a successful in-process sync before serving local reads, otherwise use the network with `REPLICA_UNPROVEN_SINCE_START`. Node/CLI adapters must provide durable pending state and fail closed to network reads rather than silently falling back to memory.
- df18325: Add the `KVReplication` policy controller and identity-scoped memory pending store, including per-replica catch-up fences, pending-write outcome handling, local get/list parity, and replication events.
  Stale-read timeouts now refresh replica status before offline admission and distinguish timeout-owned cancellation from aborts of a shared sync by its caller, close, or purge.
  Local GET and every local LIST probe now require complete coverage and valid authority from read-time metadata; a refusal falls back to network or restarts a `tcr1` continuation.
  The post-drain status refresh is bounded and caller-cancellable; status failures refuse offline admission.
- df18325: Move replication controller and memory pending-store factories out of the platform-agnostic root export. They remain available from `@tinycloud/sdk-services/kv/replication` for Node-only runtime integration, preventing Web SDK consumers from bundling the Node replication controller.

  Replication authority can now mark compact delegate sessions as session-only so a refusing session grant cannot fall back to installed device grants; an installed grant also cannot widen a refusal by the current session. KV operations avoid readiness awaits when no read-through is configured.

  In foreground read-through, reaching `staleSyncTimeoutMs` now aborts and drains the sync before serving an eligible replica result offline; a sync that exceeds the drain budget falls back to the network. Settled outcomes during the drain retain their normal classification: synced results proceed through fresh-replica gates, network failures and timeout-caused aborts may serve offline, and busy or other errors use the network with their code.

### Patch Changes

- 4756923: Location registry and target `/info` failures, single-source location resolution failures, manifest fetches, node version checks, and CLI delegation-code fetches now carry typed HTTP status. A 401 or 403 from these producers is an authorization verdict: the CLI exits with `AUTH_REQUIRED` or `PERMISSION_DENIED` instead of `ERROR`, `withSessionRefresh` signs in again on 401, and account-registry sync stops rather than retrying a single-source location 401 or 403. Location resolutions with multiple independent failures remain unclassified.

  Hook timeouts are classified from HTTP status rather than response text: 408 and 504 report `TIMEOUT`, while hook HTTP error messages containing `timeout` retain the server's diagnostic text. Account-registry retry uses the message fallback only for genuinely untyped errors. The untyped session-error fallback ignores standalone single-quoted names, not apostrophes inside words, and strips quoted names in linear time (also fixing master's slow case with many escaped double quotes).

  An account-index initialization failure, whether a failed result or a thrown error, no longer blocks or retries account-registry sync; it is warned at most once per sync with only its HTTP status and error code, and the canonical registry writes and space sync continue.

- df18325: Bound the sign-in account-registry drain to four seconds and abort its SQL, KV, and hosting requests on expiry. Registry failures remain warning-only, so sign-in succeeds after the bounded drain.
- df18325: Exact-key grants cannot cover folders under sdk-core capability containment. Local LIST keeps the exact-only network fallback and nested-LIST pending-write protection.
- 47eb547: Replication prefixes are folders such as `notes/`, or `/` for the whole space (requires a node advertising `kv-sync-root`). Bare paths and `""` are rejected.

  For local-key and eligible owner OpenKey sign-ins with unrestricted whole-space KV get coverage, replication adds sync once to the existing whole-space KV entry. Narrower owner coverage and delegated/device grants retain per-prefix scope.

  Published `@tinycloud/replica` declarations, including `./browser` and `./worker`, are self-contained; consumers do not need `@tinycloud/sdk-services`.

  `kvSyncTransport(kv)` discovers the node host exposed by the KV service for whole-space feature checks. If the service does not expose a host, pass `{ host }`; root sync refuses early with a clear error rather than skipping the `kv-sync-root` check.

- df18325: Run account-registry SQL, KV, and hosting requests through a dedicated per-operation context so the sign-in deadline cannot abort unrelated requests or persist in cached space-scoped services. Await SQL and DuckDB error-body reads before disposing request cancellation listeners.
- df18325: Replica status reads existing SQLite state read-only without creating a replica, identity, device, or blob directories, and never recreates a database that does not exist or was purged. Existing databases use normal read-only WAL mode so committed revocation and reset state is visible; SQLite may create its own WAL or shared-memory sidecars. Missing databases remain untouched, and open/read failures report unavailable rather than healthy. Inspection explicitly finalizes prepared statements before closing both inspection and ordinary store handles. Status inspection is bounded and cancelled on controller close or purge; in-process grant revocation remains visible after the handle is generation-fenced.
- df18325: Keep conditional KV write failures out of the replication committed epoch, and preserve timeout and abort error classifications for covered writes while marking their dispatch outcome ambiguous.

## 3.2.0-beta.8

### Patch Changes

- 4756923: Location registry and target `/info` failures, single-source location resolution failures, manifest fetches, node version checks, and CLI delegation-code fetches now carry typed HTTP status. A 401 or 403 from these producers is an authorization verdict: the CLI exits with `AUTH_REQUIRED` or `PERMISSION_DENIED` instead of `ERROR`, `withSessionRefresh` signs in again on 401, and account-registry sync stops rather than retrying a single-source location 401 or 403. Location resolutions with multiple independent failures remain unclassified.

  Hook timeouts are classified from HTTP status rather than response text: 408 and 504 report `TIMEOUT`, while hook HTTP error messages containing `timeout` retain the server's diagnostic text. Account-registry retry uses the message fallback only for genuinely untyped errors. The untyped session-error fallback ignores standalone single-quoted names, not apostrophes inside words, and strips quoted names in linear time (also fixing master's slow case with many escaped double quotes).

  An account-index initialization failure, whether a failed result or a thrown error, no longer blocks or retries account-registry sync; it is warned at most once per sync with only its HTTP status and error code, and the canonical registry writes and space sync continue.

## 3.2.0-beta.7

### Minor Changes

- 26f86bd: TC-628: Storage status, one `storage.full` event, and no doomed writes on read paths.
  - Storage rejections read the node's JSON 402/413 body. `meta.usedBytes`/`meta.limitBytes` still describe the space, and `meta.account` carries `{ usedBytes, limitBytes, plan }` for the whole account when the node sends it. The old plain-text body still parses. SQL and DuckDB now report a storage 413 (the node's `storage_limit_reached` body or storage text) as `STORAGE_LIMIT_REACHED`, as KV already did; a 413 without it stays `*_RESPONSE_TOO_LARGE`.
  - `tc.on("storage.full", handler)` on `TinyCloudNode` and `TinyCloudWeb` fires once, on the first write any service has rejected for storage. The event carries the code, the space numbers, `account` and the rejected `spaceId`. It also goes through the service context's `emit` as `storage.full` (`TelemetryEvents.STORAGE_FULL`). Which owners are full is recorded per owner, so a full delegated space never hides that the signed-in account is full too. It fires again once `storage.status()` has reported room for every owner whose write was rejected, or after signing in or restoring a session whose primary space belongs to a different owner. Restoring the same owner with or without the optional address/SIWE metadata keeps the episode.
  - `tc.storage.status({ space? })` reads usage and plan from the node (`tinycloud.space/info`, TC-626) and returns `{ usedBytes, limitBytes, account, plan, state, manageUrl }`. `state` is `ok`, `nearly_full` (≥ 90%) or `full`, from the account totals when known, and `limitBytes: null` means unlimited. It needs `tinycloud.space/info` on that space, from the session recap or an installed runtime delegation. Default sessions do not request it yet. When the grant cannot be confirmed locally, it returns `PERMISSION_DENIED` and sends no request. A node without the usage read returns the new `STORAGE_STATUS_UNAVAILABLE` code.
  - While the signed-in account's storage is known full:
    - `spaces.list()` still lists, but does not register each listed space;
    - sign-in skips the bootstrap repair (`bootstrapStatus.reason: "storage-full"`);
    - sign-in skips the background account registry sync (index ensure, manifest records, space sync).

    These writes would only be refused again. A rejection on another owner's space does not stop them, and does not hide a later rejection on the account's own.

  - `SpaceServiceConfig` (and `SpaceServiceConfigSchema`) accepts `isStorageFull?: () => boolean`; when it returns true, `list()` skips `onSpaceRegistered`.
  - New exports:
    - functions and values: `parseStorageRejection`, `parseStorageStatus`, `storageUsageState`, `StorageFullMonitor` (per-owner: `isFullFor(spaceId)`, `clearFor(spaceId)`), `STORAGE_MANAGE_URL`, `STORAGE_NEARLY_FULL_RATIO`, and the error code `ErrorCodes.STORAGE_STATUS_UNAVAILABLE`;
    - types: `StorageStatus`, `StorageStatusOptions`, `StorageUsage`, `StorageUsageState`, `IStorageService`, `StorageFullEvent`, `StorageFullHandler`, `StorageAccountUsage` and `StorageRejectionDetails`.
  - Deprecated, still exported unchanged: `TinyCloudQuota`, `QuotaConfig`, `QuotaStatus` and `StorageQuotaInfo`. Use `storage.status()` and `on("storage.full")` instead.

## 3.2.0-beta.5

### Patch Changes

- 47eb547: Replication prefixes are folders such as `notes/`, or `/` for the whole space (requires a node advertising `kv-sync-root`). Bare paths and `""` are rejected.

  For local-key and eligible owner OpenKey sign-ins with unrestricted whole-space KV get coverage, replication adds sync once to the existing whole-space KV entry. Narrower owner coverage and delegated/device grants retain per-prefix scope.

  Published `@tinycloud/replica` declarations, including `./browser` and `./worker`, are self-contained; consumers do not need `@tinycloud/sdk-services`.

  `kvSyncTransport(kv)` discovers the node host exposed by the KV service for whole-space feature checks. If the service does not expose a host, pass `{ host }`; root sync refuses early with a clear error rather than skipping the `kv-sync-root` check.

## 3.2.0-beta.3

### Minor Changes

- df18325: Add the Phase 1 replication contract, canonical identity and scope helpers, network-only KV read option, and nullable KVService read-through seam. With the seam unset, KV operations retain their existing network behavior. Pending-write stores declare whether their committed epoch and records survive restarts; for non-durable stores, controllers must require a successful in-process sync before serving local reads, otherwise use the network with `REPLICA_UNPROVEN_SINCE_START`. Node/CLI adapters must provide durable pending state and fail closed to network reads rather than silently falling back to memory.
- df18325: Add the `KVReplication` policy controller and identity-scoped memory pending store, including per-replica catch-up fences, pending-write outcome handling, local get/list parity, and replication events.
  Stale-read timeouts now refresh replica status before offline admission and distinguish timeout-owned cancellation from aborts of a shared sync by its caller, close, or purge.
  Local GET and every local LIST probe now require complete coverage and valid authority from read-time metadata; a refusal falls back to network or restarts a `tcr1` continuation.
  The post-drain status refresh is bounded and caller-cancellable; status failures refuse offline admission.
- df18325: Move replication controller and memory pending-store factories out of the platform-agnostic root export. They remain available from `@tinycloud/sdk-services/kv/replication` for Node-only runtime integration, preventing Web SDK consumers from bundling the Node replication controller.

  Replication authority can now mark compact delegate sessions as session-only so a refusing session grant cannot fall back to installed device grants; an installed grant also cannot widen a refusal by the current session. KV operations avoid readiness awaits when no read-through is configured.

  In foreground read-through, reaching `staleSyncTimeoutMs` now aborts and drains the sync before serving an eligible replica result offline; a sync that exceeds the drain budget falls back to the network. Settled outcomes during the drain retain their normal classification: synced results proceed through fresh-replica gates, network failures and timeout-caused aborts may serve offline, and busy or other errors use the network with their code.

### Patch Changes

- df18325: Bound the sign-in account-registry drain to four seconds and abort its SQL, KV, and hosting requests on expiry. Registry failures remain warning-only, so sign-in succeeds after the bounded drain.
- df18325: Keep published segment-aware replica selection unchanged while using sdk-core capability containment only for authority. Bare selectors now request get/sync grants for the exact path and slash descendants through the shared public `grantPathsForSelector` helper; root and trailing-slash selectors remain single-path grants. LIST local serving requires complete selection coverage, and nested LIST pending writes force network fallback or cursor restart.
- df18325: Run account-registry SQL, KV, and hosting requests through a dedicated per-operation context so the sign-in deadline cannot abort unrelated requests or persist in cached space-scoped services. Await SQL and DuckDB error-body reads before disposing request cancellation listeners.
- df18325: Replica status reads existing SQLite state read-only without creating a replica, identity, device, or blob directories, and never recreates a database that does not exist or was purged. Existing databases use normal read-only WAL mode so committed revocation and reset state is visible; SQLite may create its own WAL or shared-memory sidecars. Missing databases remain untouched, and open/read failures report unavailable rather than healthy. Inspection explicitly finalizes prepared statements before closing both inspection and ordinary store handles. Status inspection is bounded and cancelled on controller close or purge; in-process grant revocation remains visible after the handle is generation-fenced.
- df18325: Keep conditional KV write failures out of the replication committed epoch, and preserve timeout and abort error classifications for covered writes while marking their dispatch outcome ambiguous.

## 3.2.0-beta.2

### Minor Changes

- 4f851e6: Create-only secret writes, app-derived secret scopes, typed vault write errors, and classified delegation activation failures.
  - **New:** `appSecretScope(appId)` derives the canonical secret scope for an app id (`com.listen.app` → `com-listen-app`), with `SECRET_SCOPE_RE`, `MAX_SECRET_SCOPE_LENGTH` (64) and `TC832_RESERVED_SCOPES` exported from every SDK package.
  - **New:** `secrets.put(name, value, { ifAbsent: true })` (type `SecretPutOptions`) writes only when the secret does not exist. An existing secret fails with vault error `ALREADY_EXISTS` (KV 412; `meta.status` and the typed KV error as `cause`) and is never overwritten. `DataVaultService.put` accepts `{ ifNoneMatch: "*" }` for network-encrypted vaults; a legacy (key-blob) vault refuses it with `STORAGE_ERROR` before any KV call. The Node and Web secrets wrappers forward the option unchanged.
  - **New:** a refused vault write keeps its authorization classification. A refused write is `AUTH_UNAUTHORIZED` only for HTTP 401 (sign-in needed). A 403 is `PERMISSION_DENIED`. Both keep `meta.status` and the typed KV error as `cause`, so `validatedCapabilityOf` still finds the missing capability. Other failures stay `STORAGE_ERROR`, now with `meta` and the KV error chained as the cause.
  - **Fix:** KV `get`/`head`/`delete` now honour their timeout and abort signal while reading a 404 body that never finishes, instead of hanging; `createSignedReadUrl` error bodies get the same fix.
  - **New:** node-sdk classifies delegation activation failures. `useRuntimeDelegation` reports an unreachable host as an error with `code: "ACTIVATION_TRANSPORT_FAILED"`. `RuntimeDelegationRejection` gains `activation_unavailable` (transport failure, 408, 429, 5xx) and `activation_unauthenticated` (401); every other activation failure stays `activation_rejected`.

  **Breaks:**
  - Code that matched `STORAGE_ERROR` for a vault or secrets write refused by authorization now receives `AUTH_UNAUTHORIZED` (401) or `PERMISSION_DENIED` (403, or no status).
  - `VaultError`/`VaultErrorInput` gain the `ALREADY_EXISTS`, `AUTH_UNAUTHORIZED` and `PERMISSION_DENIED` variants, so exhaustive `switch`es over the vault error code need the new cases.
  - Code that enumerates `RuntimeDelegationRejection` / `RUNTIME_DELEGATION_REJECTIONS` sees two new reasons; activation failures that were `activation_rejected` may now be `activation_unavailable` or `activation_unauthenticated`.

## 3.1.0

### Minor Changes

- 0652195: Session refresh and account-registry retry now decide from the typed HTTP status instead of the error text.
  - **Typed classification.** The new `authorizationVerdictOf(error)` reads a 4xx/5xx `status`, `statusCode` or `meta.status`, or the `AUTH_UNAUTHORIZED` code. It follows the `cause` chain from the outside in and skips success statuses. The outermost error status decides.
  - **Session refresh.** `withSessionRefresh` signs in again only after a 401. A 403 never triggers a refresh, whatever its body says. To keep the typed status, throw the `ServiceError` or an `Error` with it as `cause`.
  - **Untyped errors.** Message matching is now only a fallback. It drops double-quoted strings first (escape-aware), then takes the first 400-599 status in one of the SDK's diagnostic positions (`: 403` followed by whitespace or the end, `HTTP 401`, `returned 401`, `rejected (401)`, or a trailing `(403)`), and refreshes only if that status is 401. With no status, session wording on the original message decides. Numbers inside paths, ids, ports, byte counts or quoted keys no longer count.
  - **KV messages.** KV 401/403 errors now read `<operation>: <status> - <server text>`. They keep the server text, and `meta` is unchanged. Keys in KV error messages are written with `JSON.stringify`, so a key containing quotes stays well-formed.
  - **Hooks errors.** `HooksService` HTTP failures now carry `meta.status` (and `statusText`).
  - **Account-registry sync.** The wrappers keep the service error or host result as `cause`. These wrappers are `applications.register`, `spaces.syncAccessible`, owned-space activation, owned-space hosting and post-create re-activation. A 401 or 403 therefore stops after one request, even when the body is `Forbidden` or empty, and every wrapper message carries the status.
  - **Owner delegation import.** A failed activation during owner delegation import now keeps the activation result as `cause`.
  - **New method.** `NodeUserAuthorization.hostOwnedSpaceResult()` returns the full `SpaceHostResult`. `hostOwnedSpace()` still returns `boolean`.

- a074fa5: TC-619: When the owner's storage is full, reads keep working and writes fail with one typed error.
  - `db.migrations.apply()` reads the applied-migration list first. A database that is already up to date is opened with that one read and is never written, so an app that ensures its schema on open still loads on a full space or with a read-only session. The metadata table is created only when it is missing and a migration is pending. Before this, every call wrote a batch first, and a full space failed with `SQL batch failed: 402 - Storage quota exceeded…`.
  - KV, SQL and DuckDB report a write rejected for storage with the same codes: `STORAGE_QUOTA_EXCEEDED` (HTTP 402, storage is full) or `STORAGE_LIMIT_REACHED` (HTTP 413, the write is larger than what is left). The message explains that nothing was saved, that reading still works, and what to do. `meta` carries `status`, `usedBytes` and `limitBytes`. A 413 without the node's storage text, such as a proxy's request-size limit, stays `KV_WRITE_FAILED`. Behaviour change: SQL and DuckDB previously reported a 402 as `NETWORK_ERROR`.
  - Vault and secrets writes keep the storage code, message and byte counts. Behaviour change: they previously wrapped them in `STORAGE_ERROR`.
  - New exports `isStorageFullError(error)`, `STORAGE_FULL_MESSAGE` and `STORAGE_WRITE_TOO_LARGE_MESSAGE` let an app detect "storage full" in one place and switch to a read-only view.
  - `account.spaces.list({ preferIndex: true })` still lists accessible spaces when the account space is full. An explicit `account.spaces.syncAccessible()` still reports the failure.
  - node-sdk's sign-in registry sync stops after the first storage-full rejection instead of retrying it three times.

- 045c2d3: KV `list`, `delete`, and `head` now return `AUTH_UNAUTHORIZED` with HTTP status and validated missing-capability metadata for both 401 and 403, rather than `NETWORK_ERROR` on 403. Parsed capability metadata is retained only when the TinyCloud resource and action match the request. Export `validatedCapabilityOf` for clients classifying an authorization refusal without trusting server-supplied resource or action strings.
- 698654e: TC-736: KV change feed client for `tinycloud.kv/sync` (tinycloud-node TC-732).
  - `kv.changes({ prefix, cursor?, limit?, retentionGrant?, signal?, timeout? })` reads one page of the ordered, delete-aware feed for a prefix and returns `{ changes, more, cursor, source, authority }`. Each change is a key's latest state (`{ key, deleted: false, etag, metadata }` or `{ key, deleted: true }`); read content with `get`/`batchGet` and check it against the ETag. A page never splits one invocation, so it can hold more than `limit` changes, and it can be empty with `more: true`. The cursor is opaque. The node must advertise `kv-sync-v1` in `/info`.
  - `prefix` and the returned keys are full paths in the space; the service's configured prefix is not applied. On a prefixed `KVService` such as `DelegatedAccess.kv`, strip that prefix before calling `get(change.key)`, or use `kv.withPrefix(path).changes()`, which follows everything under `path/` and returns keys relative to it. An empty prefix, on either form, is refused with `INVALID_INPUT`.
  - Errors: HTTP 410 is `KV_SYNC_RESET_REQUIRED` with `meta.reason` (`cursor-invalid` or `position-unknown`): discard sync state and restart without a cursor. A 401 naming `delegation-revoked` or `delegation-ancestor-revoked` is `AUTH_DELEGATION_REVOKED` or `AUTH_DELEGATION_ANCESTOR_REVOKED`. A refused retention grant (403) is `KV_RETENTION_GRANT_REFUSED` with `meta.reason`. A 404 for an unhosted space is `KV_NOT_FOUND`. The timeout and abort signal stay in force while an error body is read.
  - `KVAction.SYNC`, `KVAction.RETAIN`, `KV.SYNC` and `KV.RETAIN` name the new abilities. The vendored capability registry is re-vendored from tinycloud-node `d7f511f`, which registers both.
  - `tinycloud.kv/sync` and `tinycloud.kv/retain` must be granted by name. `actionContains` (exported with the new `isExplicitOnlyAction`), `SharingService.preflightGenerate()`/`generate()` and node-sdk's runtime-grant check no longer let `*` or `tinycloud.kv/*` cover them, matching the node. No default session or manifest includes them. Behaviour changes: a session holding only `tinycloud.kv/*` can no longer delegate either ability onward without a prompt, and a share asking for either under a `*` registry entry now goes to `onRootDelegationNeeded`. `SharingService` now uses `actionContains` for every action, so a `tinycloud.kv/*` registry entry covers the other KV actions there too, as it already did elsewhere.
  - Type-level break for outside implementers: `IKVService` (and the `IKVServiceLike` that `PrefixedKVService` wraps) gains a required `changes(options)` member, and `IPrefixedKVService` gains `changes(options?)`. A custom class or object that implements these interfaces must add the method to compile.
  - `secrets.listAll()` now fails with `INVALID_INPUT` when the node repeats a continuation cursor, instead of looping on a node that ignores list cursors.

### Patch Changes

- ee4fd2d: Apply the configured request timeout. `SQLService`, `KVService`, and `DuckDbService` documented a `timeout` config (and KV a per-call `timeout` option) but never used it, so a request whose response never arrived hung forever. A request now aborts once its timeout elapses, including while the response body is still being read, and the operation returns an `ErrorCodes.TIMEOUT` error with `meta.timeoutMs`. Caller and sign-out aborts still return `ErrorCodes.ABORTED`. A per-call KV `timeout` overrides the service config, and `0` disables it. There is still no default timeout: services without one configured behave as before. These services also remove, when a request finishes, the abort listeners they add to the service and context signals, which were previously left behind.
- 37123c3: `KVService.changes()` maps a 401 to `AUTH_DELEGATION_REVOKED` / `AUTH_DELEGATION_ANCESTOR_REVOKED` only when the whole response body is the node's revocation error (`delegation-revoked: <cid>`, or `delegation-ancestor-revoked: ancestor=<cid> invoked=<cid>`, optionally prefixed `Invalid invocation: `). Before, any 401 whose text contained `delegation-revoked`, such as `Unauthorized Action` for a prefix with that name, was reported as a revocation; it is now `AUTH_UNAUTHORIZED`.
- 4df61ed: `KVService.batchGet` and `batchHead` no longer fail (or misattribute results) when the requested keys are not already in key order. The node returns batch results sorted by path (it flattens invocation abilities from a `BTreeMap`), but the SDK matched them to the request by position, so an unsorted request errored with `NETWORK_ERROR` "KV batch read response did not match the requested keys". Results are now matched by the path each response item carries and returned in the caller's requested order; a response that carries no keys is aligned assuming the node's byte-sorted path order. A response that is missing a requested path, carries an unrequested one, or mixes keyed and keyless items still fails closed with `NETWORK_ERROR`.
- d11a8b6: Fix the hooks stream supervisor so a failed stream recovers instead of producing an unhandled rejection and crashing Node. Recoverable failures use bounded exponential backoff, including a fresh ticket mint after a stream-open 401/403. Terminal mint refusals reach subscribers as typed service errors. Signing out or ending the session completes active iterators. Stream telemetry is built from an allow-list and does not copy foreign error messages, causes, stacks, or metadata. Retry backoff resets only after an event is received or the stream stays open for at least five seconds. The supervisor yields through a referenced zero-delay timer after each pause so due timers are not starved by repeated immediate retries.
- Updated dependencies [02b6773]
- Updated dependencies [698654e]
  - @tinycloud/bootstrap@2.8.0

## 3.1.0-beta.14

### Patch Changes

- 4df61ed: `KVService.batchGet` and `batchHead` no longer fail (or misattribute results) when the requested keys are not already in key order. The node returns batch results sorted by path (it flattens invocation abilities from a `BTreeMap`), but the SDK matched them to the request by position, so an unsorted request errored with `NETWORK_ERROR` "KV batch read response did not match the requested keys". Results are now matched by the path each response item carries and returned in the caller's requested order; a response that carries no keys is aligned assuming the node's byte-sorted path order. A response that is missing a requested path, carries an unrequested one, or mixes keyed and keyless items still fails closed with `NETWORK_ERROR`.

## 3.1.0-beta.13

### Patch Changes

- d11a8b6: Fix the hooks stream supervisor so a failed stream recovers instead of producing an unhandled rejection and crashing Node. Recoverable failures use bounded exponential backoff, including a fresh ticket mint after a stream-open 401/403. Terminal mint refusals reach subscribers as typed service errors. Signing out or ending the session completes active iterators. Stream telemetry is built from an allow-list and does not copy foreign error messages, causes, stacks, or metadata. Retry backoff resets only after an event is received or the stream stays open for at least five seconds. The supervisor yields through a referenced zero-delay timer after each pause so due timers are not starved by repeated immediate retries.

## 3.1.0-beta.11

### Patch Changes

- Updated dependencies [02b6773]
  - @tinycloud/bootstrap@2.8.0-beta.1

## 3.1.0-beta.10

### Patch Changes

- 37123c3: `KVService.changes()` maps a 401 to `AUTH_DELEGATION_REVOKED` / `AUTH_DELEGATION_ANCESTOR_REVOKED` only when the whole response body is the node's revocation error (`delegation-revoked: <cid>`, or `delegation-ancestor-revoked: ancestor=<cid> invoked=<cid>`, optionally prefixed `Invalid invocation: `). Before, any 401 whose text contained `delegation-revoked`, such as `Unauthorized Action` for a prefix with that name, was reported as a revocation; it is now `AUTH_UNAUTHORIZED`.

## 3.1.0-beta.9

### Minor Changes

- 698654e: TC-736: KV change feed client for `tinycloud.kv/sync` (tinycloud-node TC-732).
  - `kv.changes({ prefix, cursor?, limit?, retentionGrant?, signal?, timeout? })` reads one page of the ordered, delete-aware feed for a prefix and returns `{ changes, more, cursor, source, authority }`. Each change is a key's latest state (`{ key, deleted: false, etag, metadata }` or `{ key, deleted: true }`); read content with `get`/`batchGet` and check it against the ETag. A page never splits one invocation, so it can hold more than `limit` changes, and it can be empty with `more: true`. The cursor is opaque. The node must advertise `kv-sync-v1` in `/info`.
  - `prefix` and the returned keys are full paths in the space; the service's configured prefix is not applied. On a prefixed `KVService` such as `DelegatedAccess.kv`, strip that prefix before calling `get(change.key)`, or use `kv.withPrefix(path).changes()`, which follows everything under `path/` and returns keys relative to it. An empty prefix, on either form, is refused with `INVALID_INPUT`.
  - Errors: HTTP 410 is `KV_SYNC_RESET_REQUIRED` with `meta.reason` (`cursor-invalid` or `position-unknown`): discard sync state and restart without a cursor. A 401 naming `delegation-revoked` or `delegation-ancestor-revoked` is `AUTH_DELEGATION_REVOKED` or `AUTH_DELEGATION_ANCESTOR_REVOKED`. A refused retention grant (403) is `KV_RETENTION_GRANT_REFUSED` with `meta.reason`. A 404 for an unhosted space is `KV_NOT_FOUND`. The timeout and abort signal stay in force while an error body is read.
  - `KVAction.SYNC`, `KVAction.RETAIN`, `KV.SYNC` and `KV.RETAIN` name the new abilities. The vendored capability registry is re-vendored from tinycloud-node `d7f511f`, which registers both.
  - `tinycloud.kv/sync` and `tinycloud.kv/retain` must be granted by name. `actionContains` (exported with the new `isExplicitOnlyAction`), `SharingService.preflightGenerate()`/`generate()` and node-sdk's runtime-grant check no longer let `*` or `tinycloud.kv/*` cover them, matching the node. No default session or manifest includes them. Behaviour changes: a session holding only `tinycloud.kv/*` can no longer delegate either ability onward without a prompt, and a share asking for either under a `*` registry entry now goes to `onRootDelegationNeeded`. `SharingService` now uses `actionContains` for every action, so a `tinycloud.kv/*` registry entry covers the other KV actions there too, as it already did elsewhere.
  - Type-level break for outside implementers: `IKVService` (and the `IKVServiceLike` that `PrefixedKVService` wraps) gains a required `changes(options)` member, and `IPrefixedKVService` gains `changes(options?)`. A custom class or object that implements these interfaces must add the method to compile.
  - `secrets.listAll()` now fails with `INVALID_INPUT` when the node repeats a continuation cursor, instead of looping on a node that ignores list cursors.

### Patch Changes

- Updated dependencies [698654e]
  - @tinycloud/bootstrap@2.8.0-beta.0

## 3.1.0-beta.7

### Patch Changes

- ee4fd2d: Apply the configured request timeout. `SQLService`, `KVService`, and `DuckDbService` documented a `timeout` config (and KV a per-call `timeout` option) but never used it, so a request whose response never arrived hung forever. A request now aborts once its timeout elapses, including while the response body is still being read, and the operation returns an `ErrorCodes.TIMEOUT` error with `meta.timeoutMs`. Caller and sign-out aborts still return `ErrorCodes.ABORTED`. A per-call KV `timeout` overrides the service config, and `0` disables it. There is still no default timeout: services without one configured behave as before. These services also remove, when a request finishes, the abort listeners they add to the service and context signals, which were previously left behind.

## 3.1.0-beta.6

### Minor Changes

- 045c2d3: KV `list`, `delete`, and `head` now return `AUTH_UNAUTHORIZED` with HTTP status and validated missing-capability metadata for both 401 and 403, rather than `NETWORK_ERROR` on 403. Parsed capability metadata is retained only when the TinyCloud resource and action match the request. Export `validatedCapabilityOf` for clients classifying an authorization refusal without trusting server-supplied resource or action strings.

## 3.1.0-beta.2

### Minor Changes

- a074fa5: TC-619: When the owner's storage is full, reads keep working and writes fail with one typed error.
  - `db.migrations.apply()` reads the applied-migration list first. A database that is already up to date is opened with that one read and is never written, so an app that ensures its schema on open still loads on a full space or with a read-only session. The metadata table is created only when it is missing and a migration is pending. Before this, every call wrote a batch first, and a full space failed with `SQL batch failed: 402 - Storage quota exceeded…`.
  - KV, SQL and DuckDB report a write rejected for storage with the same codes: `STORAGE_QUOTA_EXCEEDED` (HTTP 402, storage is full) or `STORAGE_LIMIT_REACHED` (HTTP 413, the write is larger than what is left). The message explains that nothing was saved, that reading still works, and what to do. `meta` carries `status`, `usedBytes` and `limitBytes`. A 413 without the node's storage text, such as a proxy's request-size limit, stays `KV_WRITE_FAILED`. Behaviour change: SQL and DuckDB previously reported a 402 as `NETWORK_ERROR`.
  - Vault and secrets writes keep the storage code, message and byte counts. Behaviour change: they previously wrapped them in `STORAGE_ERROR`.
  - New exports `isStorageFullError(error)`, `STORAGE_FULL_MESSAGE` and `STORAGE_WRITE_TOO_LARGE_MESSAGE` let an app detect "storage full" in one place and switch to a read-only view.
  - `account.spaces.list({ preferIndex: true })` still lists accessible spaces when the account space is full. An explicit `account.spaces.syncAccessible()` still reports the failure.
  - node-sdk's sign-in registry sync stops after the first storage-full rejection instead of retrying it three times.

## 3.1.0-beta.1

### Minor Changes

- 0652195: Session refresh and account-registry retry now decide from the typed HTTP status instead of the error text.
  - **Typed classification.** The new `authorizationVerdictOf(error)` reads a 4xx/5xx `status`, `statusCode` or `meta.status`, or the `AUTH_UNAUTHORIZED` code. It follows the `cause` chain from the outside in and skips success statuses. The outermost error status decides.
  - **Session refresh.** `withSessionRefresh` signs in again only after a 401. A 403 never triggers a refresh, whatever its body says. To keep the typed status, throw the `ServiceError` or an `Error` with it as `cause`.
  - **Untyped errors.** Message matching is now only a fallback. It drops double-quoted strings first (escape-aware), then takes the first 400-599 status in one of the SDK's diagnostic positions (`: 403` followed by whitespace or the end, `HTTP 401`, `returned 401`, `rejected (401)`, or a trailing `(403)`), and refreshes only if that status is 401. With no status, session wording on the original message decides. Numbers inside paths, ids, ports, byte counts or quoted keys no longer count.
  - **KV messages.** KV 401/403 errors now read `<operation>: <status> - <server text>`. They keep the server text, and `meta` is unchanged. Keys in KV error messages are written with `JSON.stringify`, so a key containing quotes stays well-formed.
  - **Hooks errors.** `HooksService` HTTP failures now carry `meta.status` (and `statusText`).
  - **Account-registry sync.** The wrappers keep the service error or host result as `cause`. These wrappers are `applications.register`, `spaces.syncAccessible`, owned-space activation, owned-space hosting and post-create re-activation. A 401 or 403 therefore stops after one request, even when the body is `Forbidden` or empty, and every wrapper message carries the status.
  - **Owner delegation import.** A failed activation during owner delegation import now keeps the activation result as `cause`.
  - **New method.** `NodeUserAuthorization.hostOwnedSpaceResult()` returns the full `SpaceHostResult`. `hostOwnedSpace()` still returns `boolean`.

## 3.0.0

### Major Changes

- b852650: Seal Policy/v3 recipient metadata as the canonical AES-256-GCM
  `version || nonce || ciphertext+tag` blob before constructing an addressed
  share link. Delivery authorization now binds that sealed blob and its
  fragment-only key, rather than accepting a plaintext `?tc2` envelope. Remove
  the public plaintext Policy/v3 inline URL codec; only sealed fragment links
  are accepted for addressed shares. Add the reusable app-neutral
  OpenCredentials invitation client and bind notification retries to the signed
  delivery JTI/nonce used by Node and OpenCredentials deduplication.

### Patch Changes

- 46c83a7: Add `secrets.listAll()` to discover global and scoped secret names across the
  canonical vault keyset without decrypting secret values.
- d8b122e: Preserve actionable sharing and KV authorization diagnostics while keeping CLI output safe and session expiry guidance prioritized.
- d8b122e: Restore backwards-compatible auth codes and preserve typed session and authorization diagnostics across SDK boundaries.
- d8b122e: Harden share publication expiry clamping and map restored-session and authorization failures to typed, safe errors.

## 3.0.0-beta.14

### Patch Changes

- d8b122e: Preserve actionable sharing and KV authorization diagnostics while keeping CLI output safe and session expiry guidance prioritized.
- d8b122e: Restore backwards-compatible auth codes and preserve typed session and authorization diagnostics across SDK boundaries.
- d8b122e: Harden share publication expiry clamping and map restored-session and authorization failures to typed, safe errors.

## 3.0.0-beta.10

### Major Changes

- b852650: Seal Policy/v3 recipient metadata as the canonical AES-256-GCM
  `version || nonce || ciphertext+tag` blob before constructing an addressed
  share link. Delivery authorization now binds that sealed blob and its
  fragment-only key, rather than accepting a plaintext `?tc2` envelope. Remove
  the public plaintext Policy/v3 inline URL codec; only sealed fragment links
  are accepted for addressed shares. Add the reusable app-neutral
  OpenCredentials invitation client and bind notification retries to the signed
  delivery JTI/nonce used by Node and OpenCredentials deduplication.

## 3.0.0-beta.8

### Patch Changes

- 46c83a7: Add `secrets.listAll()` to discover global and scoped secret names across the
  canonical vault keyset without decrypting secret values.

## 2.11.0

### Minor Changes

- b38dd12: Add versioned OpenKey authorization protocol (v1) types and consumer wiring.
  - `sdk-core` exports `TinyCloudAuthorizationRequestV1`, `TinyCloudAuthorizationResultV1`, `CapabilityPresentationEnvelopeV1`, `validateAuthorizationResultV1`, `isPlausibleOpenKeyActionId`, `OPENKEY_ACTION_ID_SEPARATOR`.
  - `sdk-core` also exports narrowing-verification helpers `extractImmutableSiweFields`, `diffImmutableSiweFields`, `extractRecapAttenuations`, `unauthorizedRecapCapabilities` (with `ImmutableSiweFields` and `RecapAttenuation` types) so consumers can prove that a widget-signed SIWE is a strict narrowing of the SDK's original prepared SIWE.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKeyResult()` which completes the session with the exact `signedMessage` the OpenKey widget returned (not the caller's original prepared SIWE). Its `prepared` argument now REQUIRES `siwe` (the SDK-generated reference SIWE). Validates that the signature verifies against the returned bytes, that the recovered signer matches the local signer, that every immutable SIWE header field (domain, address, URI, version, chainId, nonce, issuedAt) is preserved byte-for-byte, that the ReCap capability set is a subset of the original request, and that `selectedActionKeys` are covered by that set. Note: `statement` handling was refined in `sol-final-continuation-fixes.md` — earlier drafts of this changeset incorrectly implied statement drift was always allowed; the delivered rule is that statement is byte-immutable for plain SIWEs and validated via the ReCap subset check for ReCap-bearing SIWEs.
  - `cli` browser-auth advertises `protocolVersion=1` on the /delegate URL, validates every callback payload before persisting (including structural checks on the optional `permissions[]` array), and (when the response includes effective `permissions`) refuses any grant that broadens the requested set.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces EXACT MULTISET EQUALITY on the caveat list for every surviving (resource, ability) pair. Removing an entire ability or resource from the child is still permitted (that is genuine narrowing), but for any (resource, ability) that survives, the child's caveat list must equal the parent's caveat list as a multiset — i.e. same set of canonicalized caveat objects with the SAME duplicate counts. Concretely: (a) adding a caveat not present in the parent is rejected, (b) removing an alternative from a non-empty parent caveat list is rejected (removing all caveats to broaden from "restricted" to "unrestricted" is the special case of this), (c) replacing a caveat with a different one is rejected, (d) changing the number of times a duplicated caveat appears is rejected, and (e) the empty-parent case requires the child to also be empty on that ability (both sides carry zero caveats — neither imposes a restriction). Order within a caveat object's own keys is normalized via canonical JSON serialization before counting, so key reordering inside a single caveat is not itself a difference; only differences in the multiset of caveat objects matter.
  - `node-sdk.signInWithOpenKeyResult` now enforces stricter selectedActionKeys/permissions consistency: `selectedActionKeys` must cover every non-required capability in `signedMessage`; every returned `permissions` entry action must appear in `signedMessage`; broader `permissions` entries are rejected; empty `permissions[]` with a capability-bearing SIWE is rejected; duplicate `selectedActionKeys` entries are rejected; and the resource-substring fallback used to resolve permission entries has been replaced with a canonical two-form resolver (space or space+path) that fails on ambiguity.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKey(authorizeFn, opts)` — the production entry point that wires `prepareSessionForSigning` → OpenKey `authorizeTinyCloud()` → `signInWithOpenKeyResult` into one call. Callers provide a thin `authorizeFn` bridge to the OpenKey SDK; the node-sdk enforces every subset/immutable-field invariant before creating any session state.
  - `cli.parseDelegationExpiryField` numeric-seconds test fixture corrected (was passing `4_071_849_600` = Jan 11 2099, but expected Jan 1 2099 = `4_070_908_800`).
  - `node-sdk.signInWithOpenKeyResult` REJECTS legacy two-part `resource\0action` selectedActionKeys — Sol continuation contract requires the CANONICAL four-part `service\0space\0path\0ability` shape. The prior suffix-match fallback silently accepted IDs that did not carry a validated service namespace; four-part canonical IDs are the only accepted format.
  - `node-sdk` adds `wireOpenKeyAuthorize(openkey)` — a production adapter that translates any structurally-OpenKey object (typically `@openkey/sdk`'s `OpenKey` instance) into the `authorizeFn` callback `signInWithOpenKey` expects. The bridge does not fabricate protocol fields — every value flows through unchanged, and wire drift (missing `signedMessage`, unsupported `protocolVersion`, malformed selection) throws at the boundary. Enables real production consumers to wire OpenKey into `NodeUserAuthorization` without either package taking a direct build dependency on the other.

- f0842d8: TC-373: fix two blockers found in review of the batched account-bootstrap seed-spaces write.
  - `KVService.batchPut` now attaches structured metadata (`requestMayHaveDispatched`, and on the two unconfirmed-2xx response paths, `responseReceived` / `status` / `outcome: "batch-unconfirmed"`) to `NETWORK_ERROR`/`TIMEOUT` failures instead of leaving them unclassified. No new `ErrorCodes` member is added — the ambiguity is carried entirely in `meta` to avoid widening the exported `ErrorCode` union.
  - `AccountService.spaces.registerBatch`'s internal ambiguous-failure classifier is now a strict allow-list (previously a deny-list that defaulted to "retry", so deterministic failures like 400/409/422, `INVALID_INPUT`, and 501/505 triggered five pointless per-space reconcile puts). `registerBatch` now returns `RegisterBatchSuccess` (`{ spaces, recoveredFromBatchError? }`) instead of a bare array, so a batch write that recovers via per-space reconciliation is visible on the success payload, not only via `console.warn`.
  - `TinyCloudNode.bootstrapStatus` gains an optional `warnings?: BootstrapWarning[]` field: bootstrap that completes via a recovered ambiguous write is now programmatically distinguishable from a clean run (both were previously `{ skipped: false }`).

  Both changes are additive; nothing published is broken.

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- 68faad4: Reduce published SDK bundle and WASM artifact sizes by enabling safe package tree-shaking, using ES2020 output, removing release source maps, and optimizing WASM for size. `@tinycloud/sdk-services` keeps its published root entries in the `sideEffects` allowlist because they install debug globals at module scope.

  Measured by rebuilding the `origin/master` baseline (`9d4866f`) and this release tree in this worktree. Values are raw bytes / gzip level 9 bytes (`gzip -9 -c`):

  | Package entry                                                             |            Before |             After |
  | ------------------------------------------------------------------------- | ----------------: | ----------------: |
  | `@tinycloud/bootstrap` `capabilities.cjs`                                 |       6062 / 1408 |       6062 / 1408 |
  | `@tinycloud/bootstrap` `capabilities.js`                                  |        4834 / 964 |        4834 / 964 |
  | `@tinycloud/bootstrap` `generated/capabilities.cjs`                       |       7399 / 1546 |       7399 / 1546 |
  | `@tinycloud/bootstrap` `generated/capabilities.js`                        |       5971 / 1051 |       5971 / 1051 |
  | `@tinycloud/bootstrap` `index.cjs`                                        |      24918 / 5318 |      24918 / 5318 |
  | `@tinycloud/bootstrap` `index.js`                                         |      21996 / 4684 |      21996 / 4684 |
  | `@tinycloud/sdk-core` `bootstrap/index.cjs`                               |        1164 / 548 |        1164 / 548 |
  | `@tinycloud/sdk-core` `bootstrap/index.js`                                |          97 / 114 |          97 / 114 |
  | `@tinycloud/sdk-core` `delegations/index.cjs`                             |    310660 / 61313 |    309759 / 61082 |
  | `@tinycloud/sdk-core` `delegations/index.js`                              |    301141 / 59881 |    300220 / 59637 |
  | `@tinycloud/sdk-core` `index.cjs`                                         |   636247 / 125252 |   636247 / 125252 |
  | `@tinycloud/sdk-core` `index.js`                                          |   607698 / 121703 |   607698 / 121703 |
  | `@tinycloud/sdk-core` `policy/index.cjs`                                  |    109334 / 22646 |    109334 / 22646 |
  | `@tinycloud/sdk-core` `policy/index.js`                                   |    104481 / 21537 |    104481 / 21537 |
  | `@tinycloud/sdk-core` `requester/index.cjs`                               |    139251 / 29949 |    139251 / 29949 |
  | `@tinycloud/sdk-core` `requester/index.js`                                |    135505 / 29028 |    135505 / 29028 |
  | `@tinycloud/sdk-services` `encryption/index.cjs`                          |      44198 / 9624 |      44198 / 9624 |
  | `@tinycloud/sdk-services` `encryption/index.js`                           |      41192 / 8904 |      41192 / 8904 |
  | `@tinycloud/sdk-services` `index.cjs`                                     |    216891 / 41034 |    216891 / 41034 |
  | `@tinycloud/sdk-services` `index.js`                                      |    209330 / 39470 |    209330 / 39470 |
  | `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.cjs` |        1540 / 681 |        1540 / 681 |
  | `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.js`  |         419 / 268 |         419 / 268 |
  | `@tinycloud/sdk-services` `kv/index.cjs`                                  |     51068 / 10676 |     51068 / 10676 |
  | `@tinycloud/sdk-services` `kv/index.js`                                   |     49896 / 10259 |     49896 / 10259 |
  | `@tinycloud/sdk-services` `sql/index.cjs`                                 |      26895 / 6935 |      26895 / 6935 |
  | `@tinycloud/sdk-services` `sql/index.js`                                  |      25613 / 6530 |      25613 / 6530 |
  | `@tinycloud/web-sdk` `index.cjs`                                          | 3701304 / 1240268 | 3637285 / 1229488 |
  | `@tinycloud/web-sdk` `index.mjs`                                          | 3887911 / 1272304 | 3822218 / 1261105 |
  | `@tinycloud/web-sdk-wasm` `index.js`                                      |  1794903 / 695262 |  1752919 / 687800 |
  | `@tinycloud/node-sdk-wasm` `index.cjs`                                    |           61 / 91 |           61 / 91 |
  | `@tinycloud/node-sdk-wasm` `index.js`                                     |        1451 / 801 |        1451 / 801 |
  | `@tinycloud/node-sdk-wasm` `wasm/index.cjs`                               |     68817 / 10479 |     68817 / 10479 |
  | `@tinycloud/node-sdk-wasm` `wasm/tinycloud_web_sdk_rs_bg.wasm`            |  1322615 / 514215 |  1290495 / 512421 |

  The corrected `@tinycloud/web-sdk` dry-run pack contains 52 files and no `.map` files. `packages/web-sdk/tests/signInManifestRestore.test.ts` passed 8/8 with mocked auth under Bun. Live-wallet E2E was not run.

- cc75957: Sol continuation v2: add a production-shape narrowed-SIWE round-trip test
  to `NodeUserAuthorization.signInWithOpenKey.e2e.test.ts` that exercises
  the client's `signInWithOpenKeyResult` acceptance path against the exact
  wire shape the OpenKey `/authorize-sign` route emits when a user narrows
  capabilities in the widget. The test asserts:
  - The narrowed `signedMessage` decodes to the expected reduced ability
    set (kv/put removed, kv/get + capabilities/read retained).
  - The ReCap-derived statement in `signedMessage` no longer mentions the
    removed abilities.
  - The signature verifies against `signedMessage`.
  - Every canonical four-part `selectedActionKeys` entry resolves to a
    real (resource, ability) pair.
  - Every `permissions` entry has non-empty actions and matches a resource
    in the signed ReCap.

  This complements the matching OpenKey-side test in
  `apps/api/src/__tests__/delegate-authorize-sign-nodeauth-e2e.test.ts`
  which invokes the actual Hono router with the same production-shape
  SIWE. Together the two tests cover the wire boundary from both sides
  using real production code paths.

- e525137: Address Sol continuation-review rejection blockers on the OpenKey
  authorization consolidation.
  - `sdk-core.ImmutableSiweFields` now covers the full immutable header set:
    `expirationTime`, `notBefore`, `requestId`, `statement`, and
    `nonRecapResources`. `extractImmutableSiweFields` parses them and
    `diffImmutableSiweFields` includes them so a widget swapping any
    of these fields fails the SDK's byte-for-byte immutable check.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces STRICT normalized
    caveat-multiset equality. Dropping alternatives from a disjunction,
    adding restrictions to an unrestricted parent, and any lexical caveat
    change all reject. Formal attenuation may relax this later.
  - `node-sdk.signInWithOpenKeyResult` requires the returned `permissions`
    array to equal the signed authority for EVERY resource/action pair,
    including structurally-required capabilities (e.g.
    `tinycloud.capabilities/read`). Missing entries and extras both fail
    hard (was: only non-required coverage was required).
  - `node-sdk.signInWithOpenKey` accepts an optional `openkeyKeyId` option
    and forwards it to the `authorizeFn` bridge so callers can pin the
    OpenKey key ID used by the widget.
  - `cli.auth request --grant` reports EFFECTIVE grants (from the signed
    delegation) rather than the originally-requested set — the previous
    behaviour over-reported authority when the user narrowed the request
    in the OpenKey UI. Applies to both OpenKey-backed and local-key flows.
  - `node-sdk` production TypeScript build no longer includes test sources
    or test-support modules, so `tsc --noEmit -p packages/node-sdk/tsconfig.json`
    now exits 0.
  - `node-sdk.signInWithOpenKey` resolves the actual TinyCloud activation host
    before preparing or sending the OpenKey authorization request. A per-call
    host override is installed as the session host, so the host bound into the
    OpenKey context and the host later used for activation cannot diverge.

- ba9c983: Merge-readiness consolidation for the OpenKey authorization protocol.

  The manifest digest now uses a shared sorted-key canonical JSON protocol with
  OpenKey, so whitespace and object-key order in a published well-known manifest
  do not break origin binding. The mandatory cross-repository CI job is pinned to
  the immutable compatible OpenKey revision containing the real Hono harness.

  `sdk-core` (`packages/sdk-core/src/authorization/openkey-protocol.ts`):
  - Extend `CapabilityPresentationEnvelopeV1` with an optional
    `manifests: Array<{ name?: string; appId?: string; payload?: Record<string, unknown> }>`
    field. Display-only. The receiving OpenKey side size-bounds and
    validates the envelope before use; envelopes carrying trust/verification
    override keys are dropped. Manifests never expand authority — the
    ReCap payload remains the sole gate.
  - Clarify in JSDoc that `reason` is caller-supplied context and
    rendered as "reason provided by caller" in the review UI unless a
    cryptographic manifest signature (or origin-bind) confirms it.

  `node-sdk` (`packages/node-sdk/src/authorization/NodeUserAuthorization.ts`):
  - `signInWithOpenKey` now builds a `CapabilityPresentationEnvelopeV1`
    from `this._manifest` (when set) and forwards it to the caller's
    `authorizeFn`. The envelope carries `displayName`, `reason`
    (optional), `manifestId`, a canonical SHA-256 `manifestDigest` over
    the primary manifest, and the full `manifests[]` payload array.
    Callers can pass a `reason` string in `options` — rendered as
    caller-supplied, never as verified.
  - New `options.reason?: string` parameter for
    `signInWithOpenKey(authorizeFn, options)`.
  - Internal helpers `canonicalStringify` + `canonicalSha256Hex` produce
    a stable digest that the OpenKey server can match against the
    fetched `.well-known/openkey-manifest.json` bytes. Apps that want
    origin-binding MUST publish the same JSON at the well-known path.
  - The presentation envelope is forwarded VERBATIM through the
    `OpenKeyBridgeInput` shape; the bridge does not fabricate any
    fields.

  `node-sdk` (`packages/node-sdk/src/authorization/openKeyBridge.ts`):
  - Extend `OpenKeyAuthorizeTinyCloud.authorizeTinyCloud()` request
    shape and `OpenKeyBridgeInput` with the optional `presentation`
    envelope. `wireOpenKeyAuthorize` forwards it to the underlying
    OpenKey SDK unchanged.

  CI (`.github/workflows/authority-tests.yml`):
  - The isolated `authority` job now sets `OPENKEY_HARNESS_OPTIONAL: "1"`
    so the cross-repo Hono contract test skips gracefully when no
    sibling OpenKey developer worktree is present. Callers can no
    longer break the js-sdk CI merely by not having OpenKey checked out
    alongside.
  - New required `cross-repo-contract` job checks out BOTH js-sdk and
    OpenKey (from `openkey-so/openkey@main`) at compatible revisions,
    builds js-sdk's authority packages, and runs the cross-repo Hono
    contract test with `OPENKEY_WORKTREE` and `OPENKEY_RUN_HARNESS=1`
    set. The dedicated job means the real Hono contract remains
    MANDATORY — the escape hatch in the isolated job only prevents
    incidental breakage.

  Cross-repo Hono test:
  - `NodeUserAuthorization.crossRepoHono.e2e.test.ts` now spawns the
    OpenKey harness with `OPENKEY_RUN_HARNESS=1` set in the child
    environment. The harness carries a defence-in-depth guard that
    refuses to boot without that variable, so this cross-repo contract
    test is the only path that spins it up (a broad `bun test` walk in
    the OpenKey repo, or an accidental double-spawn, cannot leak a
    stuck Hono process on the port).

  Documentation-only changeset for `@tinycloud/web-sdk` and
  `@tinycloud/sdk-services`; those packages export types re-exported
  from `sdk-core`, so the envelope shape change flows through
  transitively.

- Updated dependencies [68faad4]
- Updated dependencies [d894c57]
  - @tinycloud/bootstrap@2.7.0

## 2.11.0-beta.11

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/bootstrap@2.7.0-beta.1

## 2.11.0-beta.10

### Minor Changes

- b38dd12: Add versioned OpenKey authorization protocol (v1) types and consumer wiring.
  - `sdk-core` exports `TinyCloudAuthorizationRequestV1`, `TinyCloudAuthorizationResultV1`, `CapabilityPresentationEnvelopeV1`, `validateAuthorizationResultV1`, `isPlausibleOpenKeyActionId`, `OPENKEY_ACTION_ID_SEPARATOR`.
  - `sdk-core` also exports narrowing-verification helpers `extractImmutableSiweFields`, `diffImmutableSiweFields`, `extractRecapAttenuations`, `unauthorizedRecapCapabilities` (with `ImmutableSiweFields` and `RecapAttenuation` types) so consumers can prove that a widget-signed SIWE is a strict narrowing of the SDK's original prepared SIWE.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKeyResult()` which completes the session with the exact `signedMessage` the OpenKey widget returned (not the caller's original prepared SIWE). Its `prepared` argument now REQUIRES `siwe` (the SDK-generated reference SIWE). Validates that the signature verifies against the returned bytes, that the recovered signer matches the local signer, that every immutable SIWE header field (domain, address, URI, version, chainId, nonce, issuedAt) is preserved byte-for-byte, that the ReCap capability set is a subset of the original request, and that `selectedActionKeys` are covered by that set. Note: `statement` handling was refined in `sol-final-continuation-fixes.md` — earlier drafts of this changeset incorrectly implied statement drift was always allowed; the delivered rule is that statement is byte-immutable for plain SIWEs and validated via the ReCap subset check for ReCap-bearing SIWEs.
  - `cli` browser-auth advertises `protocolVersion=1` on the /delegate URL, validates every callback payload before persisting (including structural checks on the optional `permissions[]` array), and (when the response includes effective `permissions`) refuses any grant that broadens the requested set.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces EXACT MULTISET EQUALITY on the caveat list for every surviving (resource, ability) pair. Removing an entire ability or resource from the child is still permitted (that is genuine narrowing), but for any (resource, ability) that survives, the child's caveat list must equal the parent's caveat list as a multiset — i.e. same set of canonicalized caveat objects with the SAME duplicate counts. Concretely: (a) adding a caveat not present in the parent is rejected, (b) removing an alternative from a non-empty parent caveat list is rejected (removing all caveats to broaden from "restricted" to "unrestricted" is the special case of this), (c) replacing a caveat with a different one is rejected, (d) changing the number of times a duplicated caveat appears is rejected, and (e) the empty-parent case requires the child to also be empty on that ability (both sides carry zero caveats — neither imposes a restriction). Order within a caveat object's own keys is normalized via canonical JSON serialization before counting, so key reordering inside a single caveat is not itself a difference; only differences in the multiset of caveat objects matter.
  - `node-sdk.signInWithOpenKeyResult` now enforces stricter selectedActionKeys/permissions consistency: `selectedActionKeys` must cover every non-required capability in `signedMessage`; every returned `permissions` entry action must appear in `signedMessage`; broader `permissions` entries are rejected; empty `permissions[]` with a capability-bearing SIWE is rejected; duplicate `selectedActionKeys` entries are rejected; and the resource-substring fallback used to resolve permission entries has been replaced with a canonical two-form resolver (space or space+path) that fails on ambiguity.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKey(authorizeFn, opts)` — the production entry point that wires `prepareSessionForSigning` → OpenKey `authorizeTinyCloud()` → `signInWithOpenKeyResult` into one call. Callers provide a thin `authorizeFn` bridge to the OpenKey SDK; the node-sdk enforces every subset/immutable-field invariant before creating any session state.
  - `cli.parseDelegationExpiryField` numeric-seconds test fixture corrected (was passing `4_071_849_600` = Jan 11 2099, but expected Jan 1 2099 = `4_070_908_800`).
  - `node-sdk.signInWithOpenKeyResult` REJECTS legacy two-part `resource\0action` selectedActionKeys — Sol continuation contract requires the CANONICAL four-part `service\0space\0path\0ability` shape. The prior suffix-match fallback silently accepted IDs that did not carry a validated service namespace; four-part canonical IDs are the only accepted format.
  - `node-sdk` adds `wireOpenKeyAuthorize(openkey)` — a production adapter that translates any structurally-OpenKey object (typically `@openkey/sdk`'s `OpenKey` instance) into the `authorizeFn` callback `signInWithOpenKey` expects. The bridge does not fabricate protocol fields — every value flows through unchanged, and wire drift (missing `signedMessage`, unsupported `protocolVersion`, malformed selection) throws at the boundary. Enables real production consumers to wire OpenKey into `NodeUserAuthorization` without either package taking a direct build dependency on the other.

### Patch Changes

- cc75957: Sol continuation v2: add a production-shape narrowed-SIWE round-trip test
  to `NodeUserAuthorization.signInWithOpenKey.e2e.test.ts` that exercises
  the client's `signInWithOpenKeyResult` acceptance path against the exact
  wire shape the OpenKey `/authorize-sign` route emits when a user narrows
  capabilities in the widget. The test asserts:
  - The narrowed `signedMessage` decodes to the expected reduced ability
    set (kv/put removed, kv/get + capabilities/read retained).
  - The ReCap-derived statement in `signedMessage` no longer mentions the
    removed abilities.
  - The signature verifies against `signedMessage`.
  - Every canonical four-part `selectedActionKeys` entry resolves to a
    real (resource, ability) pair.
  - Every `permissions` entry has non-empty actions and matches a resource
    in the signed ReCap.

  This complements the matching OpenKey-side test in
  `apps/api/src/__tests__/delegate-authorize-sign-nodeauth-e2e.test.ts`
  which invokes the actual Hono router with the same production-shape
  SIWE. Together the two tests cover the wire boundary from both sides
  using real production code paths.

- e525137: Address Sol continuation-review rejection blockers on the OpenKey
  authorization consolidation.
  - `sdk-core.ImmutableSiweFields` now covers the full immutable header set:
    `expirationTime`, `notBefore`, `requestId`, `statement`, and
    `nonRecapResources`. `extractImmutableSiweFields` parses them and
    `diffImmutableSiweFields` includes them so a widget swapping any
    of these fields fails the SDK's byte-for-byte immutable check.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces STRICT normalized
    caveat-multiset equality. Dropping alternatives from a disjunction,
    adding restrictions to an unrestricted parent, and any lexical caveat
    change all reject. Formal attenuation may relax this later.
  - `node-sdk.signInWithOpenKeyResult` requires the returned `permissions`
    array to equal the signed authority for EVERY resource/action pair,
    including structurally-required capabilities (e.g.
    `tinycloud.capabilities/read`). Missing entries and extras both fail
    hard (was: only non-required coverage was required).
  - `node-sdk.signInWithOpenKey` accepts an optional `openkeyKeyId` option
    and forwards it to the `authorizeFn` bridge so callers can pin the
    OpenKey key ID used by the widget.
  - `cli.auth request --grant` reports EFFECTIVE grants (from the signed
    delegation) rather than the originally-requested set — the previous
    behaviour over-reported authority when the user narrowed the request
    in the OpenKey UI. Applies to both OpenKey-backed and local-key flows.
  - `node-sdk` production TypeScript build no longer includes test sources
    or test-support modules, so `tsc --noEmit -p packages/node-sdk/tsconfig.json`
    now exits 0.
  - `node-sdk.signInWithOpenKey` resolves the actual TinyCloud activation host
    before preparing or sending the OpenKey authorization request. A per-call
    host override is installed as the session host, so the host bound into the
    OpenKey context and the host later used for activation cannot diverge.

- ba9c983: Merge-readiness consolidation for the OpenKey authorization protocol.

  The manifest digest now uses a shared sorted-key canonical JSON protocol with
  OpenKey, so whitespace and object-key order in a published well-known manifest
  do not break origin binding. The mandatory cross-repository CI job is pinned to
  the immutable compatible OpenKey revision containing the real Hono harness.

  `sdk-core` (`packages/sdk-core/src/authorization/openkey-protocol.ts`):
  - Extend `CapabilityPresentationEnvelopeV1` with an optional
    `manifests: Array<{ name?: string; appId?: string; payload?: Record<string, unknown> }>`
    field. Display-only. The receiving OpenKey side size-bounds and
    validates the envelope before use; envelopes carrying trust/verification
    override keys are dropped. Manifests never expand authority — the
    ReCap payload remains the sole gate.
  - Clarify in JSDoc that `reason` is caller-supplied context and
    rendered as "reason provided by caller" in the review UI unless a
    cryptographic manifest signature (or origin-bind) confirms it.

  `node-sdk` (`packages/node-sdk/src/authorization/NodeUserAuthorization.ts`):
  - `signInWithOpenKey` now builds a `CapabilityPresentationEnvelopeV1`
    from `this._manifest` (when set) and forwards it to the caller's
    `authorizeFn`. The envelope carries `displayName`, `reason`
    (optional), `manifestId`, a canonical SHA-256 `manifestDigest` over
    the primary manifest, and the full `manifests[]` payload array.
    Callers can pass a `reason` string in `options` — rendered as
    caller-supplied, never as verified.
  - New `options.reason?: string` parameter for
    `signInWithOpenKey(authorizeFn, options)`.
  - Internal helpers `canonicalStringify` + `canonicalSha256Hex` produce
    a stable digest that the OpenKey server can match against the
    fetched `.well-known/openkey-manifest.json` bytes. Apps that want
    origin-binding MUST publish the same JSON at the well-known path.
  - The presentation envelope is forwarded VERBATIM through the
    `OpenKeyBridgeInput` shape; the bridge does not fabricate any
    fields.

  `node-sdk` (`packages/node-sdk/src/authorization/openKeyBridge.ts`):
  - Extend `OpenKeyAuthorizeTinyCloud.authorizeTinyCloud()` request
    shape and `OpenKeyBridgeInput` with the optional `presentation`
    envelope. `wireOpenKeyAuthorize` forwards it to the underlying
    OpenKey SDK unchanged.

  CI (`.github/workflows/authority-tests.yml`):
  - The isolated `authority` job now sets `OPENKEY_HARNESS_OPTIONAL: "1"`
    so the cross-repo Hono contract test skips gracefully when no
    sibling OpenKey developer worktree is present. Callers can no
    longer break the js-sdk CI merely by not having OpenKey checked out
    alongside.
  - New required `cross-repo-contract` job checks out BOTH js-sdk and
    OpenKey (from `openkey-so/openkey@main`) at compatible revisions,
    builds js-sdk's authority packages, and runs the cross-repo Hono
    contract test with `OPENKEY_WORKTREE` and `OPENKEY_RUN_HARNESS=1`
    set. The dedicated job means the real Hono contract remains
    MANDATORY — the escape hatch in the isolated job only prevents
    incidental breakage.

  Cross-repo Hono test:
  - `NodeUserAuthorization.crossRepoHono.e2e.test.ts` now spawns the
    OpenKey harness with `OPENKEY_RUN_HARNESS=1` set in the child
    environment. The harness carries a defence-in-depth guard that
    refuses to boot without that variable, so this cross-repo contract
    test is the only path that spins it up (a broad `bun test` walk in
    the OpenKey repo, or an accidental double-spawn, cannot leak a
    stuck Hono process on the port).

  Documentation-only changeset for `@tinycloud/web-sdk` and
  `@tinycloud/sdk-services`; those packages export types re-exported
  from `sdk-core`, so the envelope shape change flows through
  transitively.

## 2.11.0-beta.8

### Patch Changes

- 68faad4: Reduce published SDK bundle and WASM artifact sizes by enabling safe package tree-shaking, using ES2020 output, removing release source maps, and optimizing WASM for size. `@tinycloud/sdk-services` keeps its published root entries in the `sideEffects` allowlist because they install debug globals at module scope.

  Measured by rebuilding the `origin/master` baseline (`9d4866f`) and this release tree in this worktree. Values are raw bytes / gzip level 9 bytes (`gzip -9 -c`):

  | Package entry                                                             |            Before |             After |
  | ------------------------------------------------------------------------- | ----------------: | ----------------: |
  | `@tinycloud/bootstrap` `capabilities.cjs`                                 |       6062 / 1408 |       6062 / 1408 |
  | `@tinycloud/bootstrap` `capabilities.js`                                  |        4834 / 964 |        4834 / 964 |
  | `@tinycloud/bootstrap` `generated/capabilities.cjs`                       |       7399 / 1546 |       7399 / 1546 |
  | `@tinycloud/bootstrap` `generated/capabilities.js`                        |       5971 / 1051 |       5971 / 1051 |
  | `@tinycloud/bootstrap` `index.cjs`                                        |      24918 / 5318 |      24918 / 5318 |
  | `@tinycloud/bootstrap` `index.js`                                         |      21996 / 4684 |      21996 / 4684 |
  | `@tinycloud/sdk-core` `bootstrap/index.cjs`                               |        1164 / 548 |        1164 / 548 |
  | `@tinycloud/sdk-core` `bootstrap/index.js`                                |          97 / 114 |          97 / 114 |
  | `@tinycloud/sdk-core` `delegations/index.cjs`                             |    310660 / 61313 |    309759 / 61082 |
  | `@tinycloud/sdk-core` `delegations/index.js`                              |    301141 / 59881 |    300220 / 59637 |
  | `@tinycloud/sdk-core` `index.cjs`                                         |   636247 / 125252 |   636247 / 125252 |
  | `@tinycloud/sdk-core` `index.js`                                          |   607698 / 121703 |   607698 / 121703 |
  | `@tinycloud/sdk-core` `policy/index.cjs`                                  |    109334 / 22646 |    109334 / 22646 |
  | `@tinycloud/sdk-core` `policy/index.js`                                   |    104481 / 21537 |    104481 / 21537 |
  | `@tinycloud/sdk-core` `requester/index.cjs`                               |    139251 / 29949 |    139251 / 29949 |
  | `@tinycloud/sdk-core` `requester/index.js`                                |    135505 / 29028 |    135505 / 29028 |
  | `@tinycloud/sdk-services` `encryption/index.cjs`                          |      44198 / 9624 |      44198 / 9624 |
  | `@tinycloud/sdk-services` `encryption/index.js`                           |      41192 / 8904 |      41192 / 8904 |
  | `@tinycloud/sdk-services` `index.cjs`                                     |    216891 / 41034 |    216891 / 41034 |
  | `@tinycloud/sdk-services` `index.js`                                      |    209330 / 39470 |    209330 / 39470 |
  | `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.cjs` |        1540 / 681 |        1540 / 681 |
  | `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.js`  |         419 / 268 |         419 / 268 |
  | `@tinycloud/sdk-services` `kv/index.cjs`                                  |     51068 / 10676 |     51068 / 10676 |
  | `@tinycloud/sdk-services` `kv/index.js`                                   |     49896 / 10259 |     49896 / 10259 |
  | `@tinycloud/sdk-services` `sql/index.cjs`                                 |      26895 / 6935 |      26895 / 6935 |
  | `@tinycloud/sdk-services` `sql/index.js`                                  |      25613 / 6530 |      25613 / 6530 |
  | `@tinycloud/web-sdk` `index.cjs`                                          | 3701304 / 1240268 | 3637285 / 1229488 |
  | `@tinycloud/web-sdk` `index.mjs`                                          | 3887911 / 1272304 | 3822218 / 1261105 |
  | `@tinycloud/web-sdk-wasm` `index.js`                                      |  1794903 / 695262 |  1752919 / 687800 |
  | `@tinycloud/node-sdk-wasm` `index.cjs`                                    |           61 / 91 |           61 / 91 |
  | `@tinycloud/node-sdk-wasm` `index.js`                                     |        1451 / 801 |        1451 / 801 |
  | `@tinycloud/node-sdk-wasm` `wasm/index.cjs`                               |     68817 / 10479 |     68817 / 10479 |
  | `@tinycloud/node-sdk-wasm` `wasm/tinycloud_web_sdk_rs_bg.wasm`            |  1322615 / 514215 |  1290495 / 512421 |

  The corrected `@tinycloud/web-sdk` dry-run pack contains 52 files and no `.map` files. `packages/web-sdk/tests/signInManifestRestore.test.ts` passed 8/8 with mocked auth under Bun. Live-wallet E2E was not run.

- Updated dependencies [68faad4]
  - @tinycloud/bootstrap@2.6.1-beta.0

## 2.11.0-beta.7

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.

## 2.11.0-beta.5

### Minor Changes

- f0842d8: TC-373: fix two blockers found in review of the batched account-bootstrap seed-spaces write.
  - `KVService.batchPut` now attaches structured metadata (`requestMayHaveDispatched`, and on the two unconfirmed-2xx response paths, `responseReceived` / `status` / `outcome: "batch-unconfirmed"`) to `NETWORK_ERROR`/`TIMEOUT` failures instead of leaving them unclassified. No new `ErrorCodes` member is added — the ambiguity is carried entirely in `meta` to avoid widening the exported `ErrorCode` union.
  - `AccountService.spaces.registerBatch`'s internal ambiguous-failure classifier is now a strict allow-list (previously a deny-list that defaulted to "retry", so deterministic failures like 400/409/422, `INVALID_INPUT`, and 501/505 triggered five pointless per-space reconcile puts). `registerBatch` now returns `RegisterBatchSuccess` (`{ spaces, recoveredFromBatchError? }`) instead of a bare array, so a batch write that recovers via per-space reconciliation is visible on the success payload, not only via `console.warn`.
  - `TinyCloudNode.bootstrapStatus` gains an optional `warnings?: BootstrapWarning[]` field: bootstrap that completes via a recovered ambiguous write is now programmatically distinguishable from a clean run (both were previously `{ skipped: false }`).

  Both changes are additive; nothing published is broken.

## 2.10.0

### Minor Changes

- 28cc430: Add batch KV reads and memoize TinyCloud node descriptor lookups to reduce SDK round trips.

## 2.10.0-beta.0

### Minor Changes

- 28cc430: Add batch KV reads and memoize TinyCloud node descriptor lookups to reduce SDK round trips.

## 2.8.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

## 2.8.0-beta.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

## 2.7.0

### Minor Changes

- d6d5ef1: Restore persisted sessions with their original private Ed25519 signer. Verify the signed SIWE, ReCap, Cacao header/CID, address, chain, session DID, and expiry before installing authority; atomically replace the auth/core/service host context while retaining every live secondary signer. Retired service graphs abort outstanding work and cannot reuse old encryption authority. Browser restore now preserves spaces and policy expiry, and rejected restores leave persisted storage untouched.
- cd8c11f: Add an explicit-space classified secret-read API that preserves safe KV,
  envelope, decrypt, and payload failure phases without changing legacy secret
  reads.

### Patch Changes

- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- Updated dependencies [940ff1d]
- Updated dependencies [f7a1d4f]
- Updated dependencies [b982b90]
  - @tinycloud/bootstrap@2.6.0

## 2.7.0-beta.4

### Minor Changes

- d6d5ef1: Restore persisted sessions with their original private Ed25519 signer. Verify the signed SIWE, ReCap, Cacao header/CID, address, chain, session DID, and expiry before installing authority; atomically replace the auth/core/service host context while retaining every live secondary signer. Retired service graphs abort outstanding work and cannot reuse old encryption authority. Browser restore now preserves spaces and policy expiry, and rejected restores leave persisted storage untouched.
- cd8c11f: Add an explicit-space classified secret-read API that preserves safe KV,
  envelope, decrypt, and payload failure phases without changing legacy secret
  reads.

### Patch Changes

- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- Updated dependencies [940ff1d]
- Updated dependencies [b982b90]
  - @tinycloud/bootstrap@2.6.0-beta.1

## 2.7.0-beta.3

### Patch Changes

- Updated dependencies [f7a1d4f]
  - @tinycloud/bootstrap@2.6.0-beta.0

## 2.6.3

### Patch Changes

- 3841be4: Fix account bootstrap failing on fresh keys because `sqlForSpace()` dropped `invokeAny` (issue #300).

  `TinyCloudNode.sqlForSpace()` (and its `kvForSpace()` counterpart) cloned the
  active service context with only `{invoke, fetch, hosts, telemetry}`, silently
  omitting `invokeAny`. Account bootstrap routes through this path: the
  `account-index-schema` step calls `account.index.ensure()`, whose migration
  batch dedupes to multiple SQL actions (`tinycloud.sql/schema` +
  `tinycloud.sql/write`). A multi-action batch requires `context.invokeAny`, so
  with it undefined `SQLService.invokeSQLAny` threw
  "SQL operation requires multiple permissions ... does not support
  multi-resource invocations", and the first `signIn()` on a fresh key failed to
  provision the account index (the `secret-records-schema` step would have hit
  the identical failure). The "recovery" on a second `signIn()` was accidental
  and incomplete — the existence check could pass and skip the schema step,
  leaving accounts without the account index.

  Thread `invokeAny` from the primary service context (`this._serviceContext.invokeAny`)
  into the space-scoped context that `sqlForSpace()` and `kvForSpace()` build, so
  multi-action bootstrap migrations mint their authorization header correctly.

## 2.6.3-beta.0

### Patch Changes

- 3841be4: Fix account bootstrap failing on fresh keys because `sqlForSpace()` dropped `invokeAny` (issue #300).

  `TinyCloudNode.sqlForSpace()` (and its `kvForSpace()` counterpart) cloned the
  active service context with only `{invoke, fetch, hosts, telemetry}`, silently
  omitting `invokeAny`. Account bootstrap routes through this path: the
  `account-index-schema` step calls `account.index.ensure()`, whose migration
  batch dedupes to multiple SQL actions (`tinycloud.sql/schema` +
  `tinycloud.sql/write`). A multi-action batch requires `context.invokeAny`, so
  with it undefined `SQLService.invokeSQLAny` threw
  "SQL operation requires multiple permissions ... does not support
  multi-resource invocations", and the first `signIn()` on a fresh key failed to
  provision the account index (the `secret-records-schema` step would have hit
  the identical failure). The "recovery" on a second `signIn()` was accidental
  and incomplete — the existence check could pass and skip the schema step,
  leaving accounts without the account index.

  Thread `invokeAny` from the primary service context (`this._serviceContext.invokeAny`)
  into the space-scoped context that `sqlForSpace()` and `kvForSpace()` build, so
  multi-action bootstrap migrations mint their authorization header correctly.

## 2.6.2

### Patch Changes

- b4d1e45: TC-111 follow-up: primary-grant selection now returns the caller's scoped
  session so multi-space recaps mint resources against the correct target space.

  TC-111 registers the primary session's own recap as a synthetic
  `provenance: "primary"` runtime grant that wins invocation selection when it
  covers the requested op. The two invocation call sites then used
  `grant.session` — the stored primary `ServiceSession`, whose `spaceId` is the
  PRIMARY space. For scoped ops on OTHER spaces that a multi-space recap also
  covers (e.g. an account-registry write whose fallback session targets the
  `account` space), the invocation was minted against the primary space
  (`applications/kv/...` instead of `account/kv/...`) and the node rejected it
  (observed as 404/40x in prod).

  `selectInvocationSession` and `invokeAnyWithRuntimePermissions` now invoke with
  the caller's passed/fallback session — which shares the primary delegation but
  carries the correct target `spaceId` — whenever the winning grant is the
  primary one. Non-primary grants keep using `grant.session`. Ranking semantics in
  `findGrantForOperations` are unchanged. This fixes wrong-space invocations for
  account/secrets ops that were minted against the primary space.

## 2.6.2-beta.0

### Patch Changes

- b4d1e45: TC-111 follow-up: primary-grant selection now returns the caller's scoped
  session so multi-space recaps mint resources against the correct target space.

  TC-111 registers the primary session's own recap as a synthetic
  `provenance: "primary"` runtime grant that wins invocation selection when it
  covers the requested op. The two invocation call sites then used
  `grant.session` — the stored primary `ServiceSession`, whose `spaceId` is the
  PRIMARY space. For scoped ops on OTHER spaces that a multi-space recap also
  covers (e.g. an account-registry write whose fallback session targets the
  `account` space), the invocation was minted against the primary space
  (`applications/kv/...` instead of `account/kv/...`) and the node rejected it
  (observed as 404/40x in prod).

  `selectInvocationSession` and `invokeAnyWithRuntimePermissions` now invoke with
  the caller's passed/fallback session — which shares the primary delegation but
  carries the correct target `spaceId` — whenever the winning grant is the
  primary one. Non-primary grants keep using `grant.session`. Ranking semantics in
  `findGrantForOperations` are unchanged. This fixes wrong-space invocations for
  account/secrets ops that were minted against the primary space.

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
