# @tinycloud/replica

## 0.4.0

### Minor Changes

- 92e4bd0: Replication accepts contentFetch "lazy", which syncs entry names without downloading values; reads of values not held go to the network.

  Details: TC-2096

- 4a19c47: Signing out erases the local copy before `signOut()` resolves: the browser replica database is deleted under the origin gate lock after the deny commit, and the same erase runs when a different account signs in on a live session. The deny floor and logout marker in `localStorage` are kept.

  If the delete is blocked or the deny kept the keys (`marker`, `unguarded`), the erase is retried three times in total (150 ms, then 450 ms apart), the logout marker makes the next load finish it, and `signOut()` still resolves for `marker`. `unguarded` still rejects, now with `code: "REPLICA_PURGE_FAILED"` unless the erase completed. After the retries `replica.purge.failed` fires (`TinyCloudWeb.on` / `TinyCloudNode.on`) with `trigger`, a typed `reason` and `retryNow`.

  `tcw.replication.purgeLocalCopy()` runs the erase on demand and returns `{ ok: true }` or `{ ok: false, retryNow }`; it never touches a live session. New exported types: `ReplicaPurgeFailedEvent`, `ReplicaPurgeLocalCopyResult`, `ReplicaPurgeTrigger`, `ReplicaLocalEraseOutcome`, `ReplicaPurgeError`. `ReplicaLifecycleGate` gains the optional browser method `eraseLocalCopy`.

  A restore with replication configured and no wallet provider stays gated, now with the gate reason `wallet_provider_required` instead of `gate_unavailable`. A read-only provider (silent `eth_accounts`, signing methods that throw) still restores.

  Details: TC-1888

### Patch Changes

- c6b4703: The replica retries a value it could not verify with growing gaps and gives up after five tries until the next session.

  Details: TC-2096

- Updated dependencies [92e4bd0]
- Updated dependencies [812a818]
- Updated dependencies [4a19c47]
- Updated dependencies [2789240]
- Updated dependencies [3daddbb]
- Updated dependencies [a83e55c]
  - @tinycloud/sdk-services@3.8.0

## 0.4.0-beta.6

### Patch Changes

- Updated dependencies [a83e55c]
  - @tinycloud/sdk-services@3.8.0-beta.22

## 0.4.0-beta.5

### Patch Changes

- Updated dependencies [3daddbb]
  - @tinycloud/sdk-services@3.8.0-beta.18

## 0.4.0-beta.4

### Patch Changes

- Updated dependencies [812a818]
  - @tinycloud/sdk-services@3.8.0-beta.16

## 0.4.0-beta.3

### Minor Changes

- 92e4bd0: Replication accepts contentFetch "lazy", which syncs entry names without downloading values; reads of values not held go to the network.

  Details: TC-2096

### Patch Changes

- Updated dependencies [92e4bd0]
  - @tinycloud/sdk-services@3.8.0-beta.9

## 0.4.0-beta.2

### Patch Changes

- c6b4703: The replica retries a value it could not verify with growing gaps and gives up after five tries until the next session.

  Details: TC-2096

## 0.4.0-beta.1

### Minor Changes

- 4a19c47: Signing out erases the local copy before `signOut()` resolves: the browser replica database is deleted under the origin gate lock after the deny commit, and the same erase runs when a different account signs in on a live session. The deny floor and logout marker in `localStorage` are kept.

  If the delete is blocked or the deny kept the keys (`marker`, `unguarded`), the erase is retried three times in total (150 ms, then 450 ms apart), the logout marker makes the next load finish it, and `signOut()` still resolves for `marker`. `unguarded` still rejects, now with `code: "REPLICA_PURGE_FAILED"` unless the erase completed. After the retries `replica.purge.failed` fires (`TinyCloudWeb.on` / `TinyCloudNode.on`) with `trigger`, a typed `reason` and `retryNow`.

  `tcw.replication.purgeLocalCopy()` runs the erase on demand and returns `{ ok: true }` or `{ ok: false, retryNow }`; it never touches a live session. New exported types: `ReplicaPurgeFailedEvent`, `ReplicaPurgeLocalCopyResult`, `ReplicaPurgeTrigger`, `ReplicaLocalEraseOutcome`, `ReplicaPurgeError`. `ReplicaLifecycleGate` gains the optional browser method `eraseLocalCopy`.

  A restore with replication configured and no wallet provider stays gated, now with the gate reason `wallet_provider_required` instead of `gate_unavailable`. A read-only provider (silent `eth_accounts`, signing methods that throw) still restores.

  Details: TC-1888

### Patch Changes

- Updated dependencies [4a19c47]
  - @tinycloud/sdk-services@3.8.0-beta.2

## 0.3.5-beta.0

### Patch Changes

- Updated dependencies [2789240]
  - @tinycloud/sdk-services@3.8.0-beta.1

## 0.3.4

### Patch Changes

- 14c685e: The replica package depends on the current @tinycloud/sdk-services release.

  Details: TC-2014

- Updated dependencies [c142537]
- Updated dependencies [4c3d073]
- Updated dependencies [279c8e9]
- Updated dependencies [147bb78]
  - @tinycloud/sdk-services@3.7.0

## 0.3.4-beta.3

### Patch Changes

- Updated dependencies [c142537]
- Updated dependencies [4c3d073]
  - @tinycloud/sdk-services@3.7.0-beta.4

## 0.3.4-beta.2

### Patch Changes

- Updated dependencies [279c8e9]
  - @tinycloud/sdk-services@3.7.0-beta.3

## 0.3.4-beta.1

### Patch Changes

- Updated dependencies [147bb78]
  - @tinycloud/sdk-services@3.7.0-beta.2

## 0.3.4-beta.0

### Patch Changes

- 14c685e: The replica package depends on the current @tinycloud/sdk-services release.

  Details: TC-2014

## 0.3.3

### Patch Changes

- dc61583: The replica workers import only the sdk-services modules they use, so the kv-storage and replica worker bundles no longer include the SQL, DuckDB, vault, and hooks services. Adds a `./context` subpath export to `@tinycloud/sdk-services`.

  Details: TC-1827

- Updated dependencies [82cbd43]
- Updated dependencies [dc61583]
  - @tinycloud/sdk-services@3.6.0

## 0.3.3-beta.1

### Patch Changes

- Updated dependencies [82cbd43]
  - @tinycloud/sdk-services@3.6.0-beta.3

## 0.3.3-beta.0

### Patch Changes

- dc61583: The replica workers import only the sdk-services modules they use, so the kv-storage and replica worker bundles no longer include the SQL, DuckDB, vault, and hooks services. Adds a `./context` subpath export to `@tinycloud/sdk-services`.

  Details: TC-1827

- Updated dependencies [dc61583]
  - @tinycloud/sdk-services@3.6.0-beta.2

## 0.3.2

### Patch Changes

- Updated dependencies [d60f81d]
  - @tinycloud/sdk-services@3.5.0

## 0.3.2-beta.0

### Patch Changes

- Updated dependencies [d60f81d]
  - @tinycloud/sdk-services@3.5.0-beta.0

## 0.3.1

### Patch Changes

- 6139879: Depend on `@tinycloud/sdk-services` 3.3.1. The 3.3.1 stable release left replica pinned to 3.3.0, so installs of replica pulled a second copy of sdk-services and the kv-storage worker bundled that older copy.

  Details: TC-1789
  - @tinycloud/sdk-services@3.3.2

## 0.3.1-beta.0

### Patch Changes

- 6139879: Depend on `@tinycloud/sdk-services` 3.3.1. The 3.3.1 stable release left replica pinned to 3.3.0, so installs of replica pulled a second copy of sdk-services and the kv-storage worker bundled that older copy.

## 0.3.0

### Minor Changes

- 0c4c6b2: `ProfileReplicaPurge.deny` with `{ deferErase: true }` now accepts only `reason: "sign_out"` and returns `ProfileReplicaDeferredDenyOutcome`, whose committed `denied` always carries `resumeToken`. `ReplicaEraseReport.deferred: true` marks a pass held by a deferred denial, so `remaining: 0` there is not completion. node-sdk exports the full contract `ProfileReplicaPurge`, requires the displayed `approval` in `prepareLogoutPending`, and reports `purgePending` from inspected status while a deferred denial or any intent remains.

  A v1 logout marker records the epoch its denial actually committed (`deniedEpoch`) in the same locked section as the deny, and every later check compares with it. A sign-out interrupted between its deny floor and gate writes is completed by the next `auth logout` (`@tinycloud/replica/profile-gate` adds `readLogoutGate`, `advanceInactiveGate` and `REPLICA_DENY_FLOOR_FILE`); reads report "a previous sign-out was interrupted; re-running `tc auth logout` completes it". A restored older gate under a recorded denial refuses with the `tc profile delete` route.

  `auth logout` by an account other than the one whose replicas the profile holds writes no marker and leaves that account's gate, floor and replicas untouched: it signs out, removes its own session and key, and erases the profile's legacy `replicas/` mirror (replayed at startup after a crash). `--revoke` there revokes only grants on the signed-in account's spaces.

  When startup recovery refuses a pending logout because a credential file is unreadable, the message now names that file (`session.json` or `profile.json`).

  CLI-bound storage and purge name the CLI's `replication/events.jsonl` and `events.jsonl.1` diagnostics logs (`diagnosticFiles`). With a readable gate, those exact names count as known only while they are regular files, so a fully synced profile signs out without `--discard-local-changes`; a symlink there stays unknown.

### Patch Changes

- 38980b0: Stamp replica sessions only from a fully verified owner SIWE with finite signed expiry and exact-space KV get+sync authority; missing proof refuses only the replica, not network sign-in. Restore validates the persisted stamp without repairing it. Browser IndexedDB sign-in, restore, and sign-out use its lifecycle without a Node profile directory; sign-out denies the gate and shreds replica keys. Replication-disabled sign-in does not inspect replica SIWE metadata.

  Node exports `createProfileReplicaPurge({ profileDir, guard })` for profile-locked CLI cleanup. A failed online revoke can durably deny local reads with `deny({ reason: "sign_out", principal }, { deferErase: true })` while retaining the network session, key, and replica files. The returned epoch/principal token resumes erasure after remote success; recovery leaves deferred files untouched and retries ordinary erasure after resume. `TinyCloudNode.signOut()` awaits durable denial before registry cleanup.
  `logoutPrincipalDigest(principal)` exposes the owner binding stored as a logout marker's `principalDigest` (advisory; not authority), so callers can check a marker against the current session before recovery.
  Node denial reads the gate snapshot and hashes the principal under the same profile lock as `denyGate`; partition and pending intents use that snapshot's salt. A gate established while denial waits for the lock is included rather than producing an empty-salt intent inventory.
  `ProfileReplica*` facade types now come from `@tinycloud/sdk-services/kv/replication`; Node SDK retains the runtime factory and marker exports without duplicate type declarations or aliases.
  Node direct sign-out and account-switch denial emits one `replication.lifecycle` event after a committed `denied`, `database_deleted`, or `marker_set` outcome to both `replication.onEvent` and the leaving service context. Stale and unguarded outcomes cannot claim a committed denial; the event carries no raw principal or space.

  CLI logout uses a profile-locked, fsynced opaque `replica-logout-pending.json` marker before deleting either `session.json` or `key.json`. CLI-bound replica reads, pending writes, restores, and already-open handles refuse while it exists. Startup recovery verifies the marker's gate incarnation/epoch/principal hash, commits full purge intents or resumes a deferred denial, removes and fsyncs both credentials, then removes the marker before retrying erase. Generic SQLite storage does not infer CLI session files; CLI callers opt in with `logoutPendingFile`. A successful remote revoke follows this same credential-shredding path; failed revoke keeps its deferred gate and credentials for retry. `recoverLogoutPending().remaining` counts durable intents only; `failed` or the marker indicates incomplete logout even when that count is zero. If writing the marker fails, an ordinary gate denial can still fence replica reads but cannot by itself recover a crash before credential unlink.
  For an active v1 plain logout, recovery commits the full generation-fenced denial and opaque intent inventory under the profile lock before calling `clearCredentials`. A denied gate write leaves the marker, both credentials, and replica files intact for retry. After a BUSY plain cleanup, reapproval recognizes that marker's same incarnation and next denied epoch with a null `deferredPrincipalHash`; the existing deferred-owner path remains intact. Remote-pending, successor, and stale markers remain fenced.

  `recoverLogoutPending` requires an idempotent `eraseLegacyReplicas` callback for the CLI's separate `<profile>/replicas` root. It runs only after the gate's full intent/generation commit, while the marker still blocks reads; the facade verifies the legacy root is gone and fsyncs the profile before clearing the marker. Failure or interruption retains the marker for retry. The callback must never delete S3's `<profile>/replication` root.
  On retry after a busy legacy SQLite lease, only source-created `replica.db-wal`, `replica.db-shm`, and `replica.db-journal` sidecars may be regenerated. Recovery still requires the originally approved database and replica directory identities; a path approved as unknown never acquires the known-sidecar exception.

  An inactive gate also gets an epoch-bound logout marker while opaque intents or legacy replicas remain. Recovery retains it until legacy-only cleanup completes; a successor gate cannot replay the old marker.

  An already-deferred v1 gate cannot mint a missing pre-denial logout marker or authorize remote revoke from its later denied epoch. Explicitly approved corrupt gates use a v2 orphan marker: after that marker is durable, the still-corrupt gate file is removed and fsynced before remote work; remote completion still requires the gate to be absent. Because that marker has no original gate-file identity, a later retry or reapproval never unlinks an unreadable gate; it fails closed with the marker and any not-yet-erased credentials or replica files intact until the gate is absent. Orphan recovery also refuses a newly corrupt or valid replacement gate before credential cleanup and again before marker removal; failures retain the marker for retry. Failed initial removal retains the marker and credentials.

  When the CLI profile's gate is missing or corrupt, scoped intents cannot be reconstructed. `prepareLogoutPending({ principal, discardLocalChanges? })` instead writes a distinct opaque orphan-profile marker before credential unlink. Without explicit `discardLocalChanges`, unsynced `pending.json` records, an unrecognized flag-owned layout, an unknown legacy child or SQLite schema, or a corrupt/unreadable gate refuse with sync-first/`--discard-local-changes` guidance. Recovery under the profile lock shreds and fsyncs both credentials, wipes only validated real `<profile>/replication` and `<profile>/replicas` roots, confirms absence and fsyncs the profile, then removes the marker. Root deletion failure leaves the marker; neither scoped intents nor a replacement gate are fabricated. CLI sign-in must check the marker before persisting a new session.

  The orphan wipe accepts the CLI lock's exact Linux `/proc/self/fd/<n>` directory pin as well as a real profile directory. It validates each replica root against that pinned directory, refuses arbitrary profile symlinks and closed pins even when roots are absent, and never redirects a wipe to a replacement profile-name symlink. With a missing gate, only a validated identity record plus an inspected empty `pending.json` and no other identity children prove a flag-owned partition has no unsynced writes; a missing index, replica files, device key, or unknown child format requires explicit discard.

  `TinyCloudNode.replicaStamp` exposes a defensive copy of the active verified stamp after sign-in or validated restore; sign-out clears it. `TinyCloudNode.signInWithOpenKey(authorizeFn, options?)` prepares the original SIWE before OpenKey approval and verifies the signed result through the existing authorization flow before committing the network session and replica stamp. The callback receives the SDK-prepared `verificationMethod` for local session-DID handoff, not as an OpenKey wire field. Optional `retryResult(error, originalRequest, attempt)` retries rejected callback transport or signed results against that same SIWE and key without retrying network activation.

  Prefix-scoped, uncaveated signed KV get+sync authority now anchors replica consent as well as root authority. Node SQLite reads pair rows with a fence captured before their SQLite snapshot. A CID's original grant installation time survives targeted partition purge; an expired effective grant refuses synchronization before transport and refuses a page that expires before commit.

- 7578ee6: SQLite replica grant installs and recomputes keep each grant's stored consent deadline and anchor from ever moving later. A compact session reopen with no owner anchor falls back to the first-install anchor, which could otherwise raise the deadline by up to the grant TTL and keep serving local reads past the owner's consent deadline.
- 94566db: Add `@tinycloud/replica/kv-storage`: `indexedDbReplicaStorage()`, the browser `ReplicaGatedStorage` for read-through replication. All replicas live in one IndexedDB database per origin (`tinycloud-replica-kv`) and are synced by a dedicated worker (`kv-storage.worker.js`) that runs the existing engine. Reads carry `LocalReadMeta`; grants report CID, parent, state, expiry and `unconstrained`, and caveated get/sync grants are refused; `sync({ signal })` cancels in the worker and commits nothing past the last complete page; `syncStartEpoch` is persisted with the sync's completion only after pages, repairs and GC; injected and stored devices get separate partitions and `purge` covers both without opening; pending writes are durable and serialised across tabs; other tabs' commits reach `onPeerCommit`. Test-only fault seams are in `@tinycloud/replica/kv-storage/testing`. The `openReplica` API (`@tinycloud/replica/browser`) and its per-replica databases are unchanged.

  Policy-only expiry returns `GRANT_EXPIRED` without deleting the account keys; only the fixed durable gate deadline returns `CONSENT_EXPIRED` and triggers key shredding.

- 94566db: Expose a post-commit browser consent-expiry subscription for bound replication controllers. Recover expired origin keys before a direct replica open so a browser closed at the deadline cannot serve local data on return. Keep the web bundle replica-free by importing grant TTL policy from the narrow policy entry.
- 86815bd: The Node profile gate keeps a durable deny floor (`replica-deny-floor.json`) beside `replica-gate.json`. After a sign-out, a missing gate file is no longer silently recreated, and a gate behind the floor fails closed with `gate_unavailable`.
- 2d491f0: Guard the published tarball: a pack check (`scripts/check-pack-exports.ts`, run in CI) fails when any `exports` target (`types`, `import`, `require`) is missing from `npm pack`. 0.2.3 shipped without `dist/browser.d.ts`, leaving `@tinycloud/replica/browser` untyped; the current build already emits it, and this check keeps that from regressing.
- 94566db: Add profile and browser replica lifecycle gates with strict persisted-stamp validation, origin-wide denial tombstones, mandatory serialization, private browser HMAC/account keys, and seven-day consent crypto-shredding. Browser denial records opaque purge intents, erases device/install anchors and their reserved quota usage, and preserves the deny floor through database deletion and v1 migration. Node gate mutations require a caller-supplied profile lock; denial advances pending-write generations with intents in one durable gate-file update. A refused replica stamp no longer rejects a valid network sign-in or restore; replication remains gated.

  Node deferred sign-out records complete opaque purge intents and pending generations with an `eraseDeferred` gate marker in the same atomic profile-file rewrite. Ordinary recovery does not erase deferred files; a profile-locked epoch/principal token clears the marker before idempotent replay. A successor account cannot reuse the token.

  The signed WASM SIWE generator preserves millisecond `Issued At` precision. Post-deny establishment requires that timestamp to be strictly later than `deniedAt`; externally generated second-precision SIWE can be refused within the same second and needs a newly signed SIWE after the next second.

  Browser startup recovery passes its abort signal to the origin Web Lock request. Aborting while queued reports unfinished recovery without changing the gate or encryption keys, allowing network sessions to continue with local replication gated.

- 86815bd: The kv-storage worker reports a start-up failure (for example WebAssembly blocked by a CSP) to the main thread, so replica calls fail at once and reads fall back to the network instead of timing out.
- 5827d70: Share a verified writable SQLite handle across concurrent controllers for the same replica directory until the last controller closes. A changed database inode is refused while a controller remains open; independent processes continue to open the replica normally.
- baca422: Pin profile and replica directories before SQLite opens during reset and sync, and for local report reads and logout cleanup. Reject whole-profile aliases, symlinked replica roots, entries, database files and persisted report descendants, changed SQLite identities, and expired profile descriptors before access. Gate legacy replica reads on pending logout, including aliases and in-flight reads. Resume cleanup of verified empty legacy replica directories after an interrupted purge without deleting unknown files.

  `@tinycloud/operations` resolves user-owned symlinked TinyCloud home directories to a pinned real directory while refusing aliases inside a profile; profile JSON reads verify leaf identity. `@tinycloud/replica` creates SQLite database files exclusively for concurrent openers and checks their identity before migration; on macOS and Windows, replica removal checks each known file and directory before nonrecursive deletion and stops on a changed or unknown entry.

  Breaking change (beta feature): `tc replica report` now reads persisted events and identity partitions without starting a replication runtime. `--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`. Use `tc replica reset --replica <name> --purge` only as a partial alternative for named local replicas. Flag-owned purge and pending clearing have no equivalent yet; TC-1309 tracks safe replacement commands.

- 8c95ddd: Add the Chromium browser acceptance harness for read-through replication: `TinyCloudWeb` with the real IndexedDB adapter against the pinned node, covering sign-in, replica and network reads, offline fallback, sign-out and deny failure paths, account switch, two-tab behaviour and the flag-off byte-identical check. CI runs it with `TC858_ACCEPTANCE_STRICT=1`, which fails on any todo or skip.
- e99a127: Replication: enforce `maxBytes` on node/CLI replica storage. A page is admitted inside the guarded commit, before any write; when the profile's stored content plus the page's new blob bytes would exceed the budget, the page is refused with `STORAGE_BUDGET` and nothing is committed. Admission charges a page its net bytes (replaced or deleted content is credited) against the content actually on disk, and orphaned blobs are collected inside the same hold so on-disk content stays within the budget. `maxBytes` bounds the committed replica content (blob bytes); during a page commit the previous blobs of replaced entries remain until the commit completes, so on-disk bytes can transiently reach cap + bytes replaced by the page; the database file, WAL, rows and the pending store are not counted. Orphaned blobs left by a crash are collected on open, under the profile guard. Without `maxBytes`, storage behaves as before.
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [9891ed9]
- Updated dependencies [87a137e]
- Updated dependencies [370a8e4]
- Updated dependencies [ef49c14]
- Updated dependencies [90bc0ae]
- Updated dependencies [0c4c6b2]
- Updated dependencies [2292db7]
  - @tinycloud/sdk-services@3.3.0

## 0.3.0-beta.11

### Patch Changes

- Updated dependencies [ef49c14]
  - @tinycloud/sdk-services@3.3.0-beta.39

## 0.3.0-beta.10

### Patch Changes

- 2d491f0: Guard the published tarball: a pack check (`scripts/check-pack-exports.ts`, run in CI) fails when any `exports` target (`types`, `import`, `require`) is missing from `npm pack`. 0.2.3 shipped without `dist/browser.d.ts`, leaving `@tinycloud/replica/browser` untyped; the current build already emits it, and this check keeps that from regressing.

## 0.3.0-beta.9

### Patch Changes

- 8c95ddd: Add the Chromium browser acceptance harness for read-through replication: `TinyCloudWeb` with the real IndexedDB adapter against the pinned node, covering sign-in, replica and network reads, offline fallback, sign-out and deny failure paths, account switch, two-tab behaviour and the flag-off byte-identical check. CI runs it with `TC858_ACCEPTANCE_STRICT=1`, which fails on any todo or skip.

## 0.3.0-beta.8

### Patch Changes

- e99a127: Replication: enforce `maxBytes` on node/CLI replica storage. A page is admitted inside the guarded commit, before any write; when the profile's stored content plus the page's new blob bytes would exceed the budget, the page is refused with `STORAGE_BUDGET` and nothing is committed. Admission charges a page its net bytes (replaced or deleted content is credited) against the content actually on disk, and orphaned blobs are collected inside the same hold so on-disk content stays within the budget. `maxBytes` bounds the committed replica content (blob bytes); during a page commit the previous blobs of replaced entries remain until the commit completes, so on-disk bytes can transiently reach cap + bytes replaced by the page; the database file, WAL, rows and the pending store are not counted. Orphaned blobs left by a crash are collected on open, under the profile guard. Without `maxBytes`, storage behaves as before.

## 0.3.0-beta.7

### Patch Changes

- 7578ee6: SQLite replica grant installs and recomputes keep each grant's stored consent deadline and anchor from ever moving later. A compact session reopen with no owner anchor falls back to the first-install anchor, which could otherwise raise the deadline by up to the grant TTL and keep serving local reads past the owner's consent deadline.

## 0.3.0-beta.6

### Patch Changes

- Updated dependencies [87a137e]
  - @tinycloud/sdk-services@3.3.0-beta.25

## 0.3.0-beta.5

### Patch Changes

- Updated dependencies [2292db7]
  - @tinycloud/sdk-services@3.3.0-beta.11

## 0.3.0-beta.4

### Minor Changes

- 0c4c6b2: `ProfileReplicaPurge.deny` with `{ deferErase: true }` now accepts only `reason: "sign_out"` and returns `ProfileReplicaDeferredDenyOutcome`, whose committed `denied` always carries `resumeToken`. `ReplicaEraseReport.deferred: true` marks a pass held by a deferred denial, so `remaining: 0` there is not completion. node-sdk exports the full contract `ProfileReplicaPurge`, requires the displayed `approval` in `prepareLogoutPending`, and reports `purgePending` from inspected status while a deferred denial or any intent remains.

  A v1 logout marker records the epoch its denial actually committed (`deniedEpoch`) in the same locked section as the deny, and every later check compares with it. A sign-out interrupted between its deny floor and gate writes is completed by the next `auth logout` (`@tinycloud/replica/profile-gate` adds `readLogoutGate`, `advanceInactiveGate` and `REPLICA_DENY_FLOOR_FILE`); reads report "a previous sign-out was interrupted; re-running `tc auth logout` completes it". A restored older gate under a recorded denial refuses with the `tc profile delete` route.

  `auth logout` by an account other than the one whose replicas the profile holds writes no marker and leaves that account's gate, floor and replicas untouched: it signs out, removes its own session and key, and erases the profile's legacy `replicas/` mirror (replayed at startup after a crash). `--revoke` there revokes only grants on the signed-in account's spaces.

  When startup recovery refuses a pending logout because a credential file is unreadable, the message now names that file (`session.json` or `profile.json`).

  CLI-bound storage and purge name the CLI's `replication/events.jsonl` and `events.jsonl.1` diagnostics logs (`diagnosticFiles`). With a readable gate, those exact names count as known only while they are regular files, so a fully synced profile signs out without `--discard-local-changes`; a symlink there stays unknown.

### Patch Changes

- 38980b0: Stamp replica sessions only from a fully verified owner SIWE with finite signed expiry and exact-space KV get+sync authority; missing proof refuses only the replica, not network sign-in. Restore validates the persisted stamp without repairing it. Browser IndexedDB sign-in, restore, and sign-out use its lifecycle without a Node profile directory; sign-out denies the gate and shreds replica keys. Replication-disabled sign-in does not inspect replica SIWE metadata.

  Node exports `createProfileReplicaPurge({ profileDir, guard })` for profile-locked CLI cleanup. A failed online revoke can durably deny local reads with `deny({ reason: "sign_out", principal }, { deferErase: true })` while retaining the network session, key, and replica files. The returned epoch/principal token resumes erasure after remote success; recovery leaves deferred files untouched and retries ordinary erasure after resume. `TinyCloudNode.signOut()` awaits durable denial before registry cleanup.
  `logoutPrincipalDigest(principal)` exposes the owner binding stored as a logout marker's `principalDigest` (advisory; not authority), so callers can check a marker against the current session before recovery.
  Node denial reads the gate snapshot and hashes the principal under the same profile lock as `denyGate`; partition and pending intents use that snapshot's salt. A gate established while denial waits for the lock is included rather than producing an empty-salt intent inventory.
  `ProfileReplica*` facade types now come from `@tinycloud/sdk-services/kv/replication`; Node SDK retains the runtime factory and marker exports without duplicate type declarations or aliases.
  Node direct sign-out and account-switch denial emits one `replication.lifecycle` event after a committed `denied`, `database_deleted`, or `marker_set` outcome to both `replication.onEvent` and the leaving service context. Stale and unguarded outcomes cannot claim a committed denial; the event carries no raw principal or space.

  CLI logout uses a profile-locked, fsynced opaque `replica-logout-pending.json` marker before deleting either `session.json` or `key.json`. CLI-bound replica reads, pending writes, restores, and already-open handles refuse while it exists. Startup recovery verifies the marker's gate incarnation/epoch/principal hash, commits full purge intents or resumes a deferred denial, removes and fsyncs both credentials, then removes the marker before retrying erase. Generic SQLite storage does not infer CLI session files; CLI callers opt in with `logoutPendingFile`. A successful remote revoke follows this same credential-shredding path; failed revoke keeps its deferred gate and credentials for retry. `recoverLogoutPending().remaining` counts durable intents only; `failed` or the marker indicates incomplete logout even when that count is zero. If writing the marker fails, an ordinary gate denial can still fence replica reads but cannot by itself recover a crash before credential unlink.
  For an active v1 plain logout, recovery commits the full generation-fenced denial and opaque intent inventory under the profile lock before calling `clearCredentials`. A denied gate write leaves the marker, both credentials, and replica files intact for retry. After a BUSY plain cleanup, reapproval recognizes that marker's same incarnation and next denied epoch with a null `deferredPrincipalHash`; the existing deferred-owner path remains intact. Remote-pending, successor, and stale markers remain fenced.

  `recoverLogoutPending` requires an idempotent `eraseLegacyReplicas` callback for the CLI's separate `<profile>/replicas` root. It runs only after the gate's full intent/generation commit, while the marker still blocks reads; the facade verifies the legacy root is gone and fsyncs the profile before clearing the marker. Failure or interruption retains the marker for retry. The callback must never delete S3's `<profile>/replication` root.
  On retry after a busy legacy SQLite lease, only source-created `replica.db-wal`, `replica.db-shm`, and `replica.db-journal` sidecars may be regenerated. Recovery still requires the originally approved database and replica directory identities; a path approved as unknown never acquires the known-sidecar exception.

  An inactive gate also gets an epoch-bound logout marker while opaque intents or legacy replicas remain. Recovery retains it until legacy-only cleanup completes; a successor gate cannot replay the old marker.

  An already-deferred v1 gate cannot mint a missing pre-denial logout marker or authorize remote revoke from its later denied epoch. Explicitly approved corrupt gates use a v2 orphan marker: after that marker is durable, the still-corrupt gate file is removed and fsynced before remote work; remote completion still requires the gate to be absent. Because that marker has no original gate-file identity, a later retry or reapproval never unlinks an unreadable gate; it fails closed with the marker and any not-yet-erased credentials or replica files intact until the gate is absent. Orphan recovery also refuses a newly corrupt or valid replacement gate before credential cleanup and again before marker removal; failures retain the marker for retry. Failed initial removal retains the marker and credentials.

  When the CLI profile's gate is missing or corrupt, scoped intents cannot be reconstructed. `prepareLogoutPending({ principal, discardLocalChanges? })` instead writes a distinct opaque orphan-profile marker before credential unlink. Without explicit `discardLocalChanges`, unsynced `pending.json` records, an unrecognized flag-owned layout, an unknown legacy child or SQLite schema, or a corrupt/unreadable gate refuse with sync-first/`--discard-local-changes` guidance. Recovery under the profile lock shreds and fsyncs both credentials, wipes only validated real `<profile>/replication` and `<profile>/replicas` roots, confirms absence and fsyncs the profile, then removes the marker. Root deletion failure leaves the marker; neither scoped intents nor a replacement gate are fabricated. CLI sign-in must check the marker before persisting a new session.

  The orphan wipe accepts the CLI lock's exact Linux `/proc/self/fd/<n>` directory pin as well as a real profile directory. It validates each replica root against that pinned directory, refuses arbitrary profile symlinks and closed pins even when roots are absent, and never redirects a wipe to a replacement profile-name symlink. With a missing gate, only a validated identity record plus an inspected empty `pending.json` and no other identity children prove a flag-owned partition has no unsynced writes; a missing index, replica files, device key, or unknown child format requires explicit discard.

  `TinyCloudNode.replicaStamp` exposes a defensive copy of the active verified stamp after sign-in or validated restore; sign-out clears it. `TinyCloudNode.signInWithOpenKey(authorizeFn, options?)` prepares the original SIWE before OpenKey approval and verifies the signed result through the existing authorization flow before committing the network session and replica stamp. The callback receives the SDK-prepared `verificationMethod` for local session-DID handoff, not as an OpenKey wire field. Optional `retryResult(error, originalRequest, attempt)` retries rejected callback transport or signed results against that same SIWE and key without retrying network activation.

  Prefix-scoped, uncaveated signed KV get+sync authority now anchors replica consent as well as root authority. Node SQLite reads pair rows with a fence captured before their SQLite snapshot. A CID's original grant installation time survives targeted partition purge; an expired effective grant refuses synchronization before transport and refuses a page that expires before commit.

- 94566db: Add `@tinycloud/replica/kv-storage`: `indexedDbReplicaStorage()`, the browser `ReplicaGatedStorage` for read-through replication. All replicas live in one IndexedDB database per origin (`tinycloud-replica-kv`) and are synced by a dedicated worker (`kv-storage.worker.js`) that runs the existing engine. Reads carry `LocalReadMeta`; grants report CID, parent, state, expiry and `unconstrained`, and caveated get/sync grants are refused; `sync({ signal })` cancels in the worker and commits nothing past the last complete page; `syncStartEpoch` is persisted with the sync's completion only after pages, repairs and GC; injected and stored devices get separate partitions and `purge` covers both without opening; pending writes are durable and serialised across tabs; other tabs' commits reach `onPeerCommit`. Test-only fault seams are in `@tinycloud/replica/kv-storage/testing`. The `openReplica` API (`@tinycloud/replica/browser`) and its per-replica databases are unchanged.

  Policy-only expiry returns `GRANT_EXPIRED` without deleting the account keys; only the fixed durable gate deadline returns `CONSENT_EXPIRED` and triggers key shredding.

- 94566db: Expose a post-commit browser consent-expiry subscription for bound replication controllers. Recover expired origin keys before a direct replica open so a browser closed at the deadline cannot serve local data on return. Keep the web bundle replica-free by importing grant TTL policy from the narrow policy entry.
- 86815bd: The Node profile gate keeps a durable deny floor (`replica-deny-floor.json`) beside `replica-gate.json`. After a sign-out, a missing gate file is no longer silently recreated, and a gate behind the floor fails closed with `gate_unavailable`.
- 94566db: Add profile and browser replica lifecycle gates with strict persisted-stamp validation, origin-wide denial tombstones, mandatory serialization, private browser HMAC/account keys, and seven-day consent crypto-shredding. Browser denial records opaque purge intents, erases device/install anchors and their reserved quota usage, and preserves the deny floor through database deletion and v1 migration. Node gate mutations require a caller-supplied profile lock; denial advances pending-write generations with intents in one durable gate-file update. A refused replica stamp no longer rejects a valid network sign-in or restore; replication remains gated.

  Node deferred sign-out records complete opaque purge intents and pending generations with an `eraseDeferred` gate marker in the same atomic profile-file rewrite. Ordinary recovery does not erase deferred files; a profile-locked epoch/principal token clears the marker before idempotent replay. A successor account cannot reuse the token.

  The signed WASM SIWE generator preserves millisecond `Issued At` precision. Post-deny establishment requires that timestamp to be strictly later than `deniedAt`; externally generated second-precision SIWE can be refused within the same second and needs a newly signed SIWE after the next second.

  Browser startup recovery passes its abort signal to the origin Web Lock request. Aborting while queued reports unfinished recovery without changing the gate or encryption keys, allowing network sessions to continue with local replication gated.

- 86815bd: The kv-storage worker reports a start-up failure (for example WebAssembly blocked by a CSP) to the main thread, so replica calls fail at once and reads fall back to the network instead of timing out.
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [90bc0ae]
- Updated dependencies [0c4c6b2]
  - @tinycloud/sdk-services@3.3.0-beta.7

## Unreleased

### Patch Changes

- Ship the KV storage worker and its inlined WASM under a SHA-256 content-hashed
  filename for immutable caching; retain the stable worker export for explicit
  custom-worker imports without immutable caching.
- Ratchet the content-hashed KV worker to its GitHub-measured Bun 1.3.14 /
  Rust 1.99.0 gzip size, with zero headroom and a toolchain check.

## 0.2.4-beta.3

### Patch Changes

- 5827d70: Share a verified writable SQLite handle across concurrent controllers for the same replica directory until the last controller closes. A changed database inode is refused while a controller remains open; independent processes continue to open the replica normally.

## 0.2.4-beta.2

### Patch Changes

- baca422: Pin profile and replica directories before SQLite opens during reset and sync, and for local report reads and logout cleanup. Reject whole-profile aliases, symlinked replica roots, entries, database files and persisted report descendants, changed SQLite identities, and expired profile descriptors before access. Gate legacy replica reads on pending logout, including aliases and in-flight reads. Resume cleanup of verified empty legacy replica directories after an interrupted purge without deleting unknown files.

  `@tinycloud/operations` resolves user-owned symlinked TinyCloud home directories to a pinned real directory while refusing aliases inside a profile; profile JSON reads verify leaf identity. `@tinycloud/replica` creates SQLite database files exclusively for concurrent openers and checks their identity before migration; on macOS and Windows, replica removal checks each known file and directory before nonrecursive deletion and stops on a changed or unknown entry.

  Breaking change (beta feature): `tc replica report` now reads persisted events and identity partitions without starting a replication runtime. `--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`. Use `tc replica reset --replica <name> --purge` only as a partial alternative for named local replicas. Flag-owned purge and pending clearing have no equivalent yet; TC-1309 tracks safe replacement commands.

## 0.2.4-beta.1

### Patch Changes

- Updated dependencies [9891ed9]
  - @tinycloud/sdk-services@3.2.6-beta.4

## 0.2.4-beta.0

### Patch Changes

- Updated dependencies [370a8e4]
  - @tinycloud/sdk-services@3.2.6-beta.2

## 0.2.3

### Patch Changes

- Updated dependencies [0b02662]
  - @tinycloud/sdk-services@3.2.5

## 0.2.3-beta.0

### Patch Changes

- Updated dependencies [0b02662]
  - @tinycloud/sdk-services@3.2.5-beta.0

## 0.2.2

### Patch Changes

- 364a679: Depend on `@tinycloud/sdk-services` 3.2.3, the version the rest of the 1.2.3 release uses, instead of the stale 3.2.2 pin.
  - @tinycloud/sdk-services@3.2.4

## 0.2.2-beta.0

### Patch Changes

- 364a679: Depend on `@tinycloud/sdk-services` 3.2.3, the version the rest of the 1.2.3 release uses, instead of the stale 3.2.2 pin.

## 0.2.1

### Patch Changes

- a007d43: Declare `@tinycloud/sdk-services` as a runtime dependency used by the replica package.
  - @tinycloud/sdk-services@3.2.2

## 0.2.1-beta.0

### Patch Changes

- a007d43: Declare `@tinycloud/sdk-services` as a runtime dependency used by the replica package.

## 0.2.0

### Minor Changes

- 47eb547: Replication prefixes are folders such as `notes/`, or `/` for the whole space (requires a node advertising `kv-sync-root`). Bare paths and `""` are rejected.

  For local-key and eligible owner OpenKey sign-ins with unrestricted whole-space KV get coverage, replication adds sync once to the existing whole-space KV entry. Narrower owner coverage and delegated/device grants retain per-prefix scope.

  Published `@tinycloud/replica` declarations, including `./browser` and `./worker`, are self-contained; consumers do not need `@tinycloud/sdk-services`.

  `kvSyncTransport(kv)` discovers the node host exposed by the KV service for whole-space feature checks. If the service does not expose a host, pass `{ host }`; root sync refuses early with a clear error rather than skipping the `kv-sync-root` check.

### Patch Changes

- 8b56ee8: Republish. The 0.1.1-beta.0 release was reported as published but never reached the npm registry, so `@tinycloud/node-sdk@3.2.0-beta.3` and `@tinycloud/cli@1.2.0-beta.3` failed to install (`ETARGET`). This release publishes the same code under a new version, and moves the dependents onto it.
- df18325: Exact-key grants cannot cover folders under sdk-core capability containment. Local LIST keeps the exact-only network fallback and nested-LIST pending-write protection.
- df18325: Replica status reads existing SQLite state read-only without creating a replica, identity, device, or blob directories, and never recreates a database that does not exist or was purged. Existing databases use normal read-only WAL mode so committed revocation and reset state is visible; SQLite may create its own WAL or shared-memory sidecars. Missing databases remain untouched, and open/read failures report unavailable rather than healthy. Inspection explicitly finalizes prepared statements before closing both inspection and ordinary store handles. Status inspection is bounded and cancelled on controller close or purge; in-process grant revocation remains visible after the handle is generation-fenced.

## 0.2.0-beta.2

### Minor Changes

- 47eb547: Replication prefixes are folders such as `notes/`, or `/` for the whole space (requires a node advertising `kv-sync-root`). Bare paths and `""` are rejected.

  For local-key and eligible owner OpenKey sign-ins with unrestricted whole-space KV get coverage, replication adds sync once to the existing whole-space KV entry. Narrower owner coverage and delegated/device grants retain per-prefix scope.

  Published `@tinycloud/replica` declarations, including `./browser` and `./worker`, are self-contained; consumers do not need `@tinycloud/sdk-services`.

  `kvSyncTransport(kv)` discovers the node host exposed by the KV service for whole-space feature checks. If the service does not expose a host, pass `{ host }`; root sync refuses early with a clear error rather than skipping the `kv-sync-root` check.

## 0.1.1-beta.1

### Patch Changes

- 8b56ee8: Republish. The 0.1.1-beta.0 release was reported as published but never reached the npm registry, so `@tinycloud/node-sdk@3.2.0-beta.3` and `@tinycloud/cli@1.2.0-beta.3` failed to install (`ETARGET`). This release publishes the same code under a new version, and moves the dependents onto it.

## 0.1.1-beta.0

### Patch Changes

- df18325: Keep published segment-aware replica selection unchanged while using sdk-core capability containment only for authority. Bare selectors now request get/sync grants for the exact path and slash descendants through the shared public `grantPathsForSelector` helper; root and trailing-slash selectors remain single-path grants. LIST local serving requires complete selection coverage, and nested LIST pending writes force network fallback or cursor restart.
- df18325: Replica status reads existing SQLite state read-only without creating a replica, identity, device, or blob directories, and never recreates a database that does not exist or was purged. Existing databases use normal read-only WAL mode so committed revocation and reset state is visible; SQLite may create its own WAL or shared-memory sidecars. Missing databases remain untouched, and open/read failures report unavailable rather than healthy. Inspection explicitly finalizes prepared statements before closing both inspection and ordinary store handles. Status inspection is bounded and cancelled on controller close or purge; in-process grant revocation remains visible after the handle is generation-fenced.

## 0.1.0

### Minor Changes

- 37123c3: New package `@tinycloud/replica` (first beta): a durable, read-only local replica of one KV prefix, kept current over the node's `tinycloud.kv/sync` change feed (`kv-sync-v1`, TinyCloud Node with TC-732). It verifies every value against the node-attested blake3 ETag before committing, commits each feed page with its cursor in one transaction, enforces the node-attested authority window offline (optionally extended by a `tinycloud.kv/retain` grant), purges itself when it learns of a revocation, and resets in place on `410 RESET_REQUIRED`. `.` exports the engine, the frozen `ReplicaTransport`/`ReplicaStore` contracts, `kvSyncTransport(kv)` over `KVService.changes()` and the worker-safe `parseUcanGrant`; `./sqlite` is the Node/Bun store (built-in `node:sqlite` on Node 22.13+, `bun:sqlite` under Bun; no native addon).

  `tc replica sync|get|list|status|reset` (CLI): sync a prefix under a device grant carrying `tinycloud.kv/sync` and `tinycloud.kv/get`, then read it with the host offline. `get`, `list`, `status` and `reset` never touch the network. On Node.js older than 22.13 every `tc replica` command exits 1 with `RUNTIME_UNSUPPORTED`; other commands keep working on Node 20.

- ada86ed: Browser local replica (TC-19): `@tinycloud/replica/browser` ships `openReplica(options)`, a main-thread client that runs the replica engine in a dedicated module worker (`dist/replica.worker.js`, a self-contained ESM bundle with the KV service and the WASM session manager inlined — no `@tinycloud/web-sdk` or `@tinycloud/node-sdk` imports). The `IndexedDbReplicaStore` keeps `meta`, `entries` and `blobs` in one `tinycloud-replica/<id>` database: one `readwrite` transaction per feed page and cursor, content-addressed blobs under `strict` durability, an in-transaction authority re-check on every commit, a `writerEpoch` fence, CID-bound grant promotion, and a fencing `markRevoked` that purges entries and blobs atomically.

  A Web Lock (`navigator.locks`, `tinycloud-replica:<replicaId>`) makes one tab the sync writer — `sync()` returns `{status:"busy"}` to other tabs — while `BroadcastChannel` relays `committed` serials to sibling workers; the lock dies with its tab. The client asks for durable storage (`navigator.storage.persist()`) and `status()` reports the result.

  `openReplica({host, space, prefix, principal, allowSecrets?, worker?})` partitions the local database as `sha256(host, space, prefix, deviceDid, principal)[:26]` (spec §8). `principal` is required — the signed-in user's identity DID, an app-asserted partition label, not an authorization check: the trust boundary is the browser origin and the node authorizes at sync time. Two principals ⇒ two replicas ⇒ two IndexedDB databases; signing in again under a rotated session key installs the new grant into the same partition and continues from its cursor. A malformed or missing `principal` throws `REPLICA_INVALID_ARGUMENT` before a worker spawns. The `worker` option accepts a `Worker`, `URL` or string for bundler layouts where `new URL("./replica.worker.js", import.meta.url)` is not visible (Vite `optimizeDeps.exclude` note in the module docs).

  Local `get`/`list`/`status` never touch the network — Chromium e2e verifies sync, blake3-identical reads, offline reload behind a fixture service worker with zero node requests, re-convergence after owner updates and deletes, out-of-scope exclusion from IndexedDB, cross-tab busy/commit/lock-release, grant expiry, revocation purge, session-key rotation into the same partition, and per-principal partition isolation.

### Patch Changes

- ada86ed: Review fixes (TC-19): `openReplica` requires `principal` — the signed-in user's identity DID — as an app-asserted partition label; the replica database key becomes `sha256(host, space, prefix, deviceDid, principal)`. Session-key rotation (every `delegateTo` signs with the session key) lands as a pending grant in the same partition and the node promotes it on the next attested page, continuing from the stored cursor. Grants are no longer issuer-bound at install: `installGrant` accepts any grant addressed to this device that covers this replica's scope in its validity window; the node authorizes at sync time. `open()` and `status()` now always return the full replica status (the `authorized` flag and restricted-status gate are gone). A malformed `principal` throws `REPLICA_INVALID_ARGUMENT` before a worker spawns.

  Second review round (TC-19): `openReplica`'s `worker` option also accepts a `() => Worker` factory, evaluated after `principal` validation so a rejected open never spawns a worker; `principal` is now validated before the worker spawns at all. `purgeReplicaStore` takes the Web Lock before the durable lease — the same order `handleReset` uses — and releases every acquired resource on failure so a BUSY purge never leaks a lease. The Chromium fixture now includes a `/default.html` importmap page that loads the packaged `dist/` verbatim, so the real `new URL("./replica.worker.js", import.meta.url)` path is exercised without a bundler-emitted worker asset masking it.

  Fourth review round (TC-19): `reset --purge` no longer deletes the IndexedDB database at all — a queued `deleteDatabase` could fire after a new replica was created under the same name, so the purge is now a wipe in place. One `readwrite` commit clears `entries` and `blobs`, drops authority and the grant, releases the lease, bumps `writerEpoch`, and stamps a durable `{purged, generation+1}` marker in `meta`; the reset resolves `{ purged: true }` the moment that commit lands and nothing after it can change the result. Every store transaction re-checks the marker and its opening generation inside the transaction itself — a tombstoned connection gets `RESET_REQUIRED` on any read or write, even if it never saw a `versionchange` — and the next `openReplica` reinitializes the same database under the next generation, so no replica created after a purge can ever be lost. The file left behind is a small empty database named by the replica's hash, holding no user data, which the next open reuses. `DeletionOutcome`, `deleteReplicaDatabase`, `deleteWaitMs`, `onDeleteBlocked` and the `deletion` result field are gone.

  Concurrent first opens can no longer race to write two device keys — `deviceIdentity` re-reads inside the write transaction and returns the stored identity — and `init` accepts an identical stored config instead of raising `REPLICA_CONFIG_MISMATCH`. `setRetentionGrant` clears the attested `retainUntil` when the retain grant CID changes (or is cleared), and a committed page only persists `retainUntil` while the stored `retentionGrantCid` still equals the CID the request presented — an in-flight sync cannot revive the previous grant's window. Both affect the SQLite store bundled into `tc replica` and the IndexedDB store. `BrowserReplica.close()` rejects in-flight and later calls with `REPLICA_CLOSED` before the close handshake is sent, so a reply arriving mid-close is ignored. Commits broadcast `committed` per page and per repair batch (not only per sync); `reset --purge` and manual `reset` broadcast to sibling tabs, whose stores surface `RESET_REQUIRED` after a sibling purge. **Breaking-ish:** `openReplica` requires `principal`; `open()`/`status()` no longer return `authorized`; `REPLICA_CLOSED` replaces `STORAGE_ERROR` for post-close calls.

- bfeb5bb: Add a package README (usage, requirements, security model) for the local replicas release candidate.
- b5b8161: Mark local replicas as a beta feature in the README for the stable release; fix the install instructions.

## 0.1.0-beta.3

### Patch Changes

- b5b8161: Mark local replicas as a beta feature in the README for the stable release; fix the install instructions.

## 0.1.0-beta.2

### Patch Changes

- bfeb5bb: Add a package README (usage, requirements, security model) for the local replicas release candidate.

## 0.1.0-beta.1

### Minor Changes

- ada86ed: Browser local replica (TC-19): `@tinycloud/replica/browser` ships `openReplica(options)`, a main-thread client that runs the replica engine in a dedicated module worker (`dist/replica.worker.js`, a self-contained ESM bundle with the KV service and the WASM session manager inlined — no `@tinycloud/web-sdk` or `@tinycloud/node-sdk` imports). The `IndexedDbReplicaStore` keeps `meta`, `entries` and `blobs` in one `tinycloud-replica/<id>` database: one `readwrite` transaction per feed page and cursor, content-addressed blobs under `strict` durability, an in-transaction authority re-check on every commit, a `writerEpoch` fence, CID-bound grant promotion, and a fencing `markRevoked` that purges entries and blobs atomically.

  A Web Lock (`navigator.locks`, `tinycloud-replica:<replicaId>`) makes one tab the sync writer — `sync()` returns `{status:"busy"}` to other tabs — while `BroadcastChannel` relays `committed` serials to sibling workers; the lock dies with its tab. The client asks for durable storage (`navigator.storage.persist()`) and `status()` reports the result.

  `openReplica({host, space, prefix, principal, allowSecrets?, worker?})` partitions the local database as `sha256(host, space, prefix, deviceDid, principal)[:26]` (spec §8). `principal` is required — the signed-in user's identity DID, an app-asserted partition label, not an authorization check: the trust boundary is the browser origin and the node authorizes at sync time. Two principals ⇒ two replicas ⇒ two IndexedDB databases; signing in again under a rotated session key installs the new grant into the same partition and continues from its cursor. A malformed or missing `principal` throws `REPLICA_INVALID_ARGUMENT` before a worker spawns. The `worker` option accepts a `Worker`, `URL` or string for bundler layouts where `new URL("./replica.worker.js", import.meta.url)` is not visible (Vite `optimizeDeps.exclude` note in the module docs).

  Local `get`/`list`/`status` never touch the network — Chromium e2e verifies sync, blake3-identical reads, offline reload behind a fixture service worker with zero node requests, re-convergence after owner updates and deletes, out-of-scope exclusion from IndexedDB, cross-tab busy/commit/lock-release, grant expiry, revocation purge, session-key rotation into the same partition, and per-principal partition isolation.

### Patch Changes

- ada86ed: Review fixes (TC-19): `openReplica` requires `principal` — the signed-in user's identity DID — as an app-asserted partition label; the replica database key becomes `sha256(host, space, prefix, deviceDid, principal)`. Session-key rotation (every `delegateTo` signs with the session key) lands as a pending grant in the same partition and the node promotes it on the next attested page, continuing from the stored cursor. Grants are no longer issuer-bound at install: `installGrant` accepts any grant addressed to this device that covers this replica's scope in its validity window; the node authorizes at sync time. `open()` and `status()` now always return the full replica status (the `authorized` flag and restricted-status gate are gone). A malformed `principal` throws `REPLICA_INVALID_ARGUMENT` before a worker spawns.

  Second review round (TC-19): `openReplica`'s `worker` option also accepts a `() => Worker` factory, evaluated after `principal` validation so a rejected open never spawns a worker; `principal` is now validated before the worker spawns at all. `purgeReplicaStore` takes the Web Lock before the durable lease — the same order `handleReset` uses — and releases every acquired resource on failure so a BUSY purge never leaks a lease. The Chromium fixture now includes a `/default.html` importmap page that loads the packaged `dist/` verbatim, so the real `new URL("./replica.worker.js", import.meta.url)` path is exercised without a bundler-emitted worker asset masking it.

  Fourth review round (TC-19): `reset --purge` no longer deletes the IndexedDB database at all — a queued `deleteDatabase` could fire after a new replica was created under the same name, so the purge is now a wipe in place. One `readwrite` commit clears `entries` and `blobs`, drops authority and the grant, releases the lease, bumps `writerEpoch`, and stamps a durable `{purged, generation+1}` marker in `meta`; the reset resolves `{ purged: true }` the moment that commit lands and nothing after it can change the result. Every store transaction re-checks the marker and its opening generation inside the transaction itself — a tombstoned connection gets `RESET_REQUIRED` on any read or write, even if it never saw a `versionchange` — and the next `openReplica` reinitializes the same database under the next generation, so no replica created after a purge can ever be lost. The file left behind is a small empty database named by the replica's hash, holding no user data, which the next open reuses. `DeletionOutcome`, `deleteReplicaDatabase`, `deleteWaitMs`, `onDeleteBlocked` and the `deletion` result field are gone.

  Concurrent first opens can no longer race to write two device keys — `deviceIdentity` re-reads inside the write transaction and returns the stored identity — and `init` accepts an identical stored config instead of raising `REPLICA_CONFIG_MISMATCH`. `setRetentionGrant` clears the attested `retainUntil` when the retain grant CID changes (or is cleared), and a committed page only persists `retainUntil` while the stored `retentionGrantCid` still equals the CID the request presented — an in-flight sync cannot revive the previous grant's window. Both affect the SQLite store bundled into `tc replica` and the IndexedDB store. `BrowserReplica.close()` rejects in-flight and later calls with `REPLICA_CLOSED` before the close handshake is sent, so a reply arriving mid-close is ignored. Commits broadcast `committed` per page and per repair batch (not only per sync); `reset --purge` and manual `reset` broadcast to sibling tabs, whose stores surface `RESET_REQUIRED` after a sibling purge. **Breaking-ish:** `openReplica` requires `principal`; `open()`/`status()` no longer return `authorized`; `REPLICA_CLOSED` replaces `STORAGE_ERROR` for post-close calls.

## 0.1.0-beta.0

### Minor Changes

- 37123c3: New package `@tinycloud/replica` (first beta): a durable, read-only local replica of one KV prefix, kept current over the node's `tinycloud.kv/sync` change feed (`kv-sync-v1`, TinyCloud Node with TC-732). It verifies every value against the node-attested blake3 ETag before committing, commits each feed page with its cursor in one transaction, enforces the node-attested authority window offline (optionally extended by a `tinycloud.kv/retain` grant), purges itself when it learns of a revocation, and resets in place on `410 RESET_REQUIRED`. `.` exports the engine, the frozen `ReplicaTransport`/`ReplicaStore` contracts, `kvSyncTransport(kv)` over `KVService.changes()` and the worker-safe `parseUcanGrant`; `./sqlite` is the Node/Bun store (built-in `node:sqlite` on Node 22.13+, `bun:sqlite` under Bun; no native addon).

  `tc replica sync|get|list|status|reset` (CLI): sync a prefix under a device grant carrying `tinycloud.kv/sync` and `tinycloud.kv/get`, then read it with the host offline. `get`, `list`, `status` and `reset` never touch the network. On Node.js older than 22.13 every `tc replica` command exits 1 with `RUNTIME_UNSUPPORTED`; other commands keep working on Node 20.
