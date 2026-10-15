# Shared replica contract (TC-858 Phase 2), rev 2

This document is normative for every `KVReplicaStorage` adapter: the browser IndexedDB adapter (`@tinycloud/replica/kv-storage`) and the node/CLI SQLite adapter (`@tinycloud/node-sdk`). Both implement the **same** interfaces. They differ only in where state is stored and how a transaction is realised, and each section has "Browser" and "Node/CLI" notes for that. The types live in this directory:

| File | Contents |
| -- | -- |
| `types.ts` | storage, handle, controller, options, status and event types; `ReplicaGatedStorage`, `ReplicaGatedSpec` |
| `lifecycle.ts` | session stamp, account gate, `ReplicaGateTx.run`, erase seam, lifecycle facade |
| `grantPolicyTypes.ts` | consent anchor, grant policy, policy function signatures |
| `quota.ts` | quota spec, page admission, ledger seam, node admit hook |
| `contractConstants.ts` | error codes, defaults, store and file names |

`contractConstants` and `grantPolicyTypes` are subpath exports (`@tinycloud/sdk-services/kv/replication/contractConstants`, `…/grantPolicyTypes`). The constants are not re-exported from the package root.

**Only replication off is byte-identical.** With replication off, nothing in this contract runs. With replication on, everything here is mandatory:
- the lifecycle gate (§2);
- the session stamp;
- the grant policy (§3).

The new fields are optional in the Phase 1 types only so existing callers and test doubles compile. Phase 2 adapters use `ReplicaGatedStorage` and `ReplicaGatedSpec`, which require them.

**Source compatibility.** This is **not** a source-compatible change for exhaustive consumers. `ReplicaState` (`gated`), `ReplicationReason` (`replica_gated`), `ReplicationEvent` (`replication.grant`, `replication.lifecycle`), the sync `trigger` (`peer`) and `class` (`lifecycle`) all gain members. Replication is pre-GA (beta), and the break is accepted.

Conventions:
- Instants are milliseconds since the Unix epoch, durations are milliseconds and sizes are bytes, unless a field says ISO string.
- Errors are `Error & { code: string }`. Gate refusals also carry `gate`.

## 1. `KVReplicaStorage` and handles

**Reads never return unauthorised data.** `get` and `list` run through `ReplicaGateTx.run` (§2). Adapters MUST NOT return value bytes or list keys unless the **effective authority** is `valid`. That covers:
- the signed `exp`;
- the effective expiry;
- the consent deadline;
- node-attested authority;
- revocation.

Otherwise they throw `GRANT_EXPIRED`, `GRANT_REVOKED`, `GRANT_NOT_YET_VALID` or `CONSENT_EXPIRED` inside the read transaction. The controller then falls through to the network with the matching reason (`grant_expired`, `grant_revoked` or `grant_not_yet_valid`).

Results carry `LocalReadMeta` (`asOf`, `coverage`, `authority`, `syncedThroughEpoch`). `authority` is therefore always `valid` on a returned result.

**Grant metadata.** `grant()` (a guarded read) and `installGrant()` return `ReplicaGrantInfo`:
- `cid`, `parentCid`, `state` (`active` | `pending`) and `unconstrained` are as in Phase 1;
- `expiresAt` is the **signed** `exp` in ms;
- `installedAt`, `effectiveExpiresAt`, `consentDeadline` and `consentAnchor` are present on every Phase 2 grant (§3).

**Install validation.** `installGrant(ucan)` is guarded. It:
- rejects `GRANT_AUDIENCE_MISMATCH` unless the audience is the handle's device;
- rejects `GRANT_NOT_COVERING` unless the grant covers both `tinycloud.kv/get` and `tinycloud.kv/sync` on the prefix **with no caveats**.

**Sync and cancellation.** `sync({ signal, syncStartEpoch })`:
- **Abort.** Aborting `signal` stops at the last complete page. Nothing past it commits, and the epoch does not move. The browser cancels through a cancel RPC keyed by request id.
- **`close()`** cancels in-flight syncs and resolves after they settle.
- **Epoch finalisation.** `syncStartEpoch` is persisted **in the same transaction as the completion marker**, only after the whole sync has finished: feed pages, repairs and GC. Failed, aborted and busy syncs leave the previous `syncedThroughEpoch`, including a failure after the last feed page.

Every page commit, repair batch, GC pass and the completion run through `ReplicaGateTx.run`.

**Device injection.** If `spec.device` is set, the adapter uses that device for partition naming, audience checks and signing, and never loads or mints its own. If it's absent, the adapter uses its stored owner-minted device:
- browser: one per origin, in the `device` store, rotated by `deny` (§2);
- node: `device.jwk` per identity. It is durably deleted by the erase of the identity's `pending` intent (§2).

**Identifiers.** Every salted id uses `SaltedHash(salt, material)`: lowercase hex HMAC-SHA-256, keyed with the base64url-decoded per-incarnation `salt`, over the UTF-8 `material`. It is implemented once in `@tinycloud/replica` `src/profile-gate/saltedHash.ts` and shared by both platforms.
- The principal hash (both platforms) is over the lower-cased principal DID.
- Browser `partitionId` is over `replicationIdentityKey(identity) + "\n" + prefix + "\n" + deviceDid`.
- Browser `identityKeyHash` is over `replicationIdentityKey(identity)`.

The browser `replicaId` in events is the salted `partitionId`. Salted ids die with the incarnation.

**Browser ordering rule.** `SaltedHash` is async, so it is **never** awaited inside an open IndexedDB transaction:
1. `snapshot()` runs before any transaction and returns `{ incarnation, salt, lifecycleEpoch }`.
2. The salted ids are derived **outside any transaction**.
3. `run(scope, { stamp, principal, incarnation, partitionId?, identityKeyHash? }, fn)` runs. Its **first IDB request** reads the gate record and compares the incarnation (and therefore the salt), the stamp and the principal hash. Any mismatch throws `stamp_stale` (or the matching gate reason), and nothing is written.

Raw identity inputs are never persisted; only stored salted ids are.

Node/CLI keeps its existing unsalted SHA-256 base32 directory names, which is a **known node exposure**: a filesystem reader can test candidate identities.

**`purge(target)`** erases without opening, minting or syncing:
- it covers the deduplicated union of the stored device and `target.sessionDeviceDid`;
- it is exempt from the gate (erasure is always allowed);
- erasing a partition removes its index entry;
- handles opened earlier reject `RESET_REQUIRED`. This is detected by tombstone/generation, never by unlinking, because POSIX keeps unlinked files readable.

**`inspectStatus(spec, { signal })`** is bounded, read-only and cancellable. It never creates anything. It is **ungated** (it has no stamp), which is a **known metadata exposure**: counts, bytes, grant CIDs and times, never values or keys.

**Status additions:**
- `persisted: boolean | null`. Browser: `navigator.storage.persist()`; node omits it.
- `purgePending: boolean`.

**Pending writes.** `pendingWrites(identity, { stamp })` returns a durable store (`durable: true`) scoped by identity. On an open failure it surfaces `STORAGE_ERROR` and never substitutes memory.
- The store is bound to its stamp, and callers cache stores per identity **and** stamp.
- Every `read`, `readExisting` and `update` (append, settle, remove, clear, flush) runs through `ReplicaGateTx.run` with `{ stamp, principal, incarnation, identityKeyHash }`.
- **Browser:** the `pending` store, keyed by the salted `identityKeyHash`. The store's `update(mutate)` closure runs on the **main thread**, so the pending store uses a main-thread `ReplicaGateTx` (§2). Read-modify-write is serialised across tabs like this:
  1. `snapshot()`;
  2. derive `identityKeyHash`;
  3. take the Web Lock `REPLICA_PENDING_LOCK_PREFIX + identityKeyHash`;
  4. `run` with the snapshot's `incarnation`.

  A changed incarnation or stamp fails closed (`stamp_stale`).
- Node/CLI: `pending.json` under the identity directory. Updates hold the profile lock; reads follow the node read rule (§2).

**Peer commits.** `spec.onPeerCommit` is called when **another** tab or process commits a sync for the partition (browser: the worker's `committed` message on `REPLICA_KV_CHANNEL`). It is never called for the handle's own commits, and it must not throw. The controller emits `replication.sync` with `trigger: "peer"` and `origin: "peer"`, and does not sync.

**Error precedence:** `REPLICA_GATED`, then `RESET_REQUIRED`, then `GRANT_*` / `CONSENT_EXPIRED`, then storage and network codes.

## 2. Lifecycle and epoch gate

### State

**Account gate** `ReplicaAccountGate { incarnation, salt, principalHash, lifecycleEpoch, deniedAt }`. It holds no plaintext principal.
- `incarnation` and `salt` are random, created with the gate store, and replaced when it is recreated.
- `lifecycleEpoch` goes up by one on every committed deny and never goes down within an incarnation.
- `deniedAt` is the time of the last committed deny.

**Partition index** `{ partitionId, principalHash, identityKeyHash, createdAt }`. It holds no principal, prefix or device in clear. A partition is registered with `indexPartition` inside the `run` transaction that creates it, and removed with `unindexPartition` inside its erase.

**Purge intents** are `partition` intents (id = `partitionId`) and `pending` intents (id = `"pending:" + identityKeyHash`), each carrying `principalHash`. A partition or identity with an outstanding intent is unreadable.

| | Browser | Node/CLI |
| -- | -- | -- |
| Gate, index, intents | `gate` (key `"account"`), `partitions`, `purgeIntents` stores in `tinycloud-replica-kv` | `replica-gate.json` (`REPLICA_GATE_FILE`): `{ v: 1, incarnation, salt, principalHash, lifecycleEpoch, deniedAt, intents, firstInstall }`, where `principalHash` is `SaltedHash` hex. Written atomically (temp file + rename) under the profile lock. CLI: `<profile>/replica-gate.json`. The node-sdk `gateFile` option defaults next to `dir`, outside the replication data. The index may be derived from the on-disk layout |
| First-install anchors | `device` store, key `"firstInstall:" + identityKeyHash` | the gate file's `firstInstall: { [identityKeyHash]: ms }` |
| Cross-tab/process signal | `localStorage` marker `REPLICA_LOGOUT_MARKER`; BroadcastChannel `REPLICA_KV_CHANNEL`; the `storage` event | the gate file, checked by `run` |
| Session stamp persisted in | sdk-core `PersistedSessionData.replicaStamp` (S3 adds it to the zod schema: `incarnation: string`, `lifecycleEpoch: non-negative int`), next to the SIWE | the profile's persisted session record |

**The gate is mandatory with replication on.**
- `indexedDbReplicaStorage()` MUST expose `lifecycle`, and the web runtime refuses storage without it with `RUNTIME_UNSUPPORTED`.
- `sqliteReplicaStorage()` exposes it by default.
- With `lifecycle` present, a missing `deps.stamp` makes the controller `gated` (`not_established`) and it never opens.
- A missing `spec.grantPolicy` makes the adapter reject `open` with `REPLICA_INVALID_ARGUMENT`.

**Construction boundary (browser).** A `ReplicaGateTx` is constructed alongside whichever context **owns the transaction**. Both instances open the same origin database:
- **Worker:** replica open, reads, page commits, repair, GC and erase. It is built together with `ReplicaPartitionEraser` and `ReplicaQuotaLedger` via `createKvWorkerHost({ gateTx, ledgerFor })`.
- **Main thread:** the pending store, whose `update(mutate)` closure runs there.

No `IDBTransaction` and no closure ever crosses postMessage. `ReplicaLifecycleGate` is the main-thread facade.

### Session stamp

`ReplicaSessionStamp { incarnation, lifecycleEpoch }` is bound to one session object for its whole life.
- **Fresh sign-in only:** `establishSessionStamp(principal, { siweIssuedAt })`.
  1. Rejects `logout_pending` or `purge_pending` **before any gate mutation**.
  2. Rejects `stamp_stale` when `siweIssuedAt ≤ gate.deniedAt`. A SIWE minted before the last deny can't establish; clock rollback is accepted, as in §3.
  3. Then, by gate principal:
     - null → set it, with no epoch bump (deny already bumped);
     - equal → return the current stamp (tabs of one account share it);
     - another account → `principal_mismatch`. The caller runs the switch sequence, or it is stale.

  The result is persisted with the session.
- **Restore only:** `restoreSessionStamp(principal, persisted)` **never mutates the gate**. It returns `persisted` when it equals the gate's stamp and principal. Otherwise it rejects:
  - `not_established` (no persisted stamp);
  - `stamp_stale`;
  - `principal_mismatch`;
  - `logout_pending`;
  - `purge_pending`.

  Restored sessions validate their persisted stamp; they never establish one.
- **No rebinding.** A controller is never rebound with a new stamp for an existing session object. A new stamp requires a new session.

### The structural guard: `ReplicaGateTx.run`

**Rule:** every transaction that reads or writes a data store (`meta`, `entries`, `blobs`, `pending`, and `device`) MUST go through `run(scope, access, fn)`. Only purge/erase transactions are exempt. This explicitly includes:
- open, get, list, status and `grant()`;
- `installGrant`;
- every page commit, repair batch and GC pass;
- sync completion;
- every pending-store `read`/`readExisting`/`update`.

`run(scope, access, fn)` opens the transaction itself over `scope.stores` **plus every control store** (`gate`, `partitions`, `purgeIntents`, `quota`). Its first request reads the gate and asserts `access`:
- stamp;
- principal hash;
- `access.incarnation`;
- intents covering the stored `partitionId` / `identityKeyHash`.

Then it runs `fn(tx)`. The assert is internal to `run`; there is no public `assert`. `access` carries the raw principal (hashed by the gate) and the **stored** salted ids (derived by the caller from `snapshot()`).

**Browser completion:** `readwrite` transactions use `{ durability: "strict" }`. `run` resolves only on the transaction's `oncomplete`; an abort or error rejects.

The assert refuses with `REPLICA_GATED`, aborts, and never runs `fn` when:
- the stamp's incarnation or epoch differs (`stamp_stale`);
- the gate's principal is null or another account (`principal_mismatch`);
- an intent covers `partitionId` or `identityKeyHash` (`purge_pending`);
- the gate can't be read (`gate_unavailable`).

**Node/CLI transaction semantics:**
- **Mutations** (page commit, `installGrant`, pending update, GC, repair) hold the **profile lock** across the gate check and the SQLite commit.
- **Guarded reads** take no profile lock. They run inside a SQLite read transaction that checks the gate (gate-file stat of mtime, size and inode, re-read on change) **and** the partition's **tombstone row**. A read that began before the tombstone commit linearises before the deny.

**Gated results:** `open`, `get`, `list`, `status`, `grant()`, `installGrant`, `sync` and pending-store calls reject `REPLICA_GATED`. Nothing is read, created or written, and a sync's current page aborts with the epoch unchanged. `RESET_REQUIRED` is reserved for handles whose partition was **erased** after they opened.

**Controller behaviour when gated:**
- reads go to the network with `reason: "replica_gated"`;
- status is `gated` with a `gate` reason;
- sync errors carry `class: "lifecycle"`;
- there is no open backoff.

When the pending store is gated, the whole controller becomes `gated` for that stamp. Covered writes are then dispatched to the network **without** a pending record. Pending records only protect local serving, and none will happen. This differs deliberately from Phase 1's `STORAGE_ERROR` path, which refuses to dispatch. A session with no established stamp (for example B before activation) binds no controller.

### Delivery and stale replies

`deliverable(stamp)` is synchronous and takes a **required** stamp. No stamp means not deliverable; `if (stamp && !deliverable(stamp))` is wrong.
- Browser: the `localStorage` marker plus this tab's gate view.
- Node/CLI: this process's view.

The main thread calls it before:
- handing any **replica-served** value to a caller: get values, list keys, and replica-derived event fields (`replication.divergence` `localOnly`, `localEtag`);
- every open, `installGrant` and sync request.

Worker replies carrying replica-served data are stamped (`ReplicaStampedReply`). Deliver only if `reply.stamp` deep-equals `handle.stamp` **and** `deliverable(reply.stamp)`. A reply without a stamp is dropped.

### Sign-out and account switch

1. **Deny.** `deny({ reason, principal, next? })` flips this tab's or process's in-memory view **before its first await**, whatever the outcome.
   - If `principal` doesn't match the gate, the caller is stale. It disables itself in memory and the gate is untouched (`stale`).
   - Otherwise one commit:
     - moves the gate: principal null (sign-out) or `next` (switch), `lifecycleEpoch + 1`, `deniedAt`;
     - records intents for every indexed partition and pending record of that principal;
     - clears its `first_install` anchors;
     - deletes the owner `device` record. It is rotated: a new one is created on the next activation.
       - **Browser:** this happens in the same IndexedDB transaction.
       - **Node exception:** the gate file and the device record can't commit atomically. Step 1 commits the epoch, the intents and the `firstInstall` clearing in the gate file. The device record is then **durably deleted by the erase of the identity's `pending` intent, before that intent clears**. Replay after a crash is idempotent. Denial is still immediate, because the in-memory view flips first and every guarded transaction checks the gate.

   Outcomes:
   - `denied`.
   - `stale`.
   - `deleted` (browser): the commit failed, and `deleteDatabase(REPLICA_KV_DATABASE)` succeeded. Every connection closes on `onversionchange`, and a recreated database has a new incarnation and salt.
   - `marker` (browser): the delete failed or stayed blocked, and `REPLICA_LOGOUT_MARKER` was set. The marker blocks activation and delivery everywhere. Every load retries the delete, and the marker is cleared only once the delete succeeds.
   - `unguarded`: nothing could be written, so **cross-tab denial is not guaranteed**. This tab serves nothing. The docs state the limitation.
2. **Drain.** This tab's handles are cancelled and closed. Others are refused from their next transaction and nudged over the BroadcastChannel and the `storage` event.
3. **Erase.** `erasePending()` erases each intent in its own exempt transaction: `erasePartition` / `eraseIdentityPending`, `unindexPartition`, `accountErase` and `clearIntent`. Replay is idempotent: erasing a missing or tombstoned partition succeeds.
   - **Browser:** all of it is in one transaction.
   - **Node order:**
     1. gate epoch bump + intent (step 1, atomic rename);
     2. a SQLite transaction that writes the tombstone and deletes rows;
     3. commit;
     4. unlink files;
     5. clear the intent (atomic rename).

     The erase must be durable before the intent clears.
4. **Activate** (switch only). `activationAllowed(next)` requires that:
   - `gate.principalHash` matches `next` (or null followed by `establishSessionStamp`);
   - no intent of a previous principal remains;
   - no marker is set.

   Until then, B's KV goes to the network.

**`signOut` resolves** only after this tab's handles are cancelled and closed **and** step 1 has committed (or returned a fallback outcome). Erasure continues in the background.

**Startup.** `recover()` runs before anything binds:
1. the browser retries the pending delete if the marker is set;
2. then every outstanding intent is erased.

It never rejects; leftovers show as `purgePending`.

## 3. Grant duration and renewal

**Policy inputs.** `ReplicationOptions.grantTtlMs` defaults to `DEFAULT_GRANT_TTL_MS` (24 h). A value `≤ 0` or above `MAX_GRANT_TTL_MS` (7 d) is a `TypeError`.

With replication on, the controller **always** passes `KVReplicaSpec.grantPolicy = { grantTtlMs, consentAnchor }`, and adapters reject `open` without it.

**Consent anchor** (`ReplicationAuthority.consentAnchor()`), in fallback order:
1. the SIWE `issuedAt` (`siwe`);
2. the compact delegation's `iat` (`delegation_iat`);
3. then its `nbf` (`delegation_nbf`);
4. otherwise `null`, and storage uses its persisted `first_install` time.

**Anchor invariants:**
- `at` is finite ms.
- Second-based sources are converted ×1000 **exactly once**, at the authority.
- Every anchor passes `clampConsentAnchor(anchor, now)` **at capture**. It clamps to ≤ now; a non-finite value gives `null`, and the next source is used.
- Renewals never re-anchor.
- `first_install` is keyed by identity. It survives partition reset, purge, revocation and reinstall, and is cleared **only by `deny`** (§2). An unreadable anchor **fails closed**: no serving and no mint.

**Consent deadline** = `anchor.at + CONSENT_WINDOW_MS` (7 d).

**Effective expiry:**

```
effectiveGrantExpiry({ signedExpiresAt, installedAt, grantTtlMs, consentDeadline })
  = min(signedExpiresAt ?? ∞, installedAt + grantTtlMs, consentDeadline)
```

`installedAt` comes from the storage clock at the **first** install of that grant CID. It is stored keyed by CID and set once: re-installing doesn't refresh it, and recompute-at-open uses the stored value. The adapter stores the effective expiry with the grant and **recomputes it at open** from the current policy, which caps grants restored from an older policy.

**Serve checks fail closed,** inside the read transaction:
- Serving requires `now < effectiveExpiresAt` **and** `now < consentDeadline`. Each check is a refusal on `!(now < bound)`, so `NaN` refuses.
- A missing or non-finite stored bound refuses.
- A refusal throws `GRANT_EXPIRED`, or `CONSENT_EXPIRED` for the deadline (§1). The read goes to the network with `grant_expired`.
- Expiry blocks reads; it does not erase.

**Clock rollback is an accepted risk for Phase 2.** Local bounds use `Date.now()`. The node-enforced signed `exp` still bounds every network use.

**Every grant path:**

| Path | Rule |
| -- | -- |
| Fresh mint | `mint(deviceDid, prefix, signal, { expiryMs })`, where `expiryMs = mintRemainingMs(…) = min(grantTtlMs, consentDeadline − now)`. It is a **duration**, forwarded as `delegateTo(…, { expiry: expiryMs })`. No mint when it is `≤ 0` (`CONSENT_EXPIRED`) |
| Session grant reused directly | installed only if within policy. Otherwise it's replaced by a derived capped grant (`canRenew`), or its effective expiry is enforced locally (`capped`) |
| Compact delegated / `sessionOnly` | effective expiry enforced locally; no silent renewal |
| Installed grant reused at open | only if the stored `effectiveExpiresAt` is ahead and `now < consentDeadline` |
| Restored from an older policy | recomputed at open; capped locally |

**Silent renewal.** `needsSilentRenewal(…)` is true when the remaining lifetime is **strictly** below `RENEW_BELOW_FRACTION × (effectiveExpiresAt − installedAt)` (exactly 25% remaining does not renew) and `now < consentDeadline`. It is false for non-finite inputs.
- It is checked on a timer, before each sync, and at open.
- It renews only through the session-key derivation path of `delegateTo`, never with a wallet prompt.
- On refusal or offline, the current grant serves until its effective expiry.

**Events** (`replication.grant`, keyed by an opaque `replicaId`): `minted`, `renewed`, `renewal_refused`, `renewal_deferred`, `capped`, `expired` and `consent_deadline_reached` (`CONSENT_EXPIRED`).

**After the deadline:** no mint, no renewal and no local reads. Network reads continue. A fresh sign-in re-anchors.

S4 implements `effectiveGrantExpiry`, `consentDeadlineMs`, `mintRemainingMs`, `needsSilentRenewal` and `clampConsentAnchor` in `grantPolicy.ts`.

## 4. Quota

**Options.**
- `maxBytes`: absent means unbounded.
- `minFreeBytes`: browser only, defaulting to `DEFAULT_MIN_FREE_BYTES` (64 MiB).

Both are forwarded as `KVReplicaSpec.quota`.

| | Browser | Node/CLI |
| -- | -- | -- |
| Budget scope | origin-wide | per profile (per storage `dir`) |
| Ledger | `quota` control store, in worker-side `run` page transactions and erase transactions; `accountErase` is idempotent once the partition entry is gone | none: usage is derived from stored content, so erase replay is safe |
| Seam | `ReplicaQuotaLedger<IDBTransaction>` | `ReplicaAdmitHook` (the `admit` option), run inside `applyPage`'s mutation under the profile lock |
| Free-space floor | `freeBytes()` (`navigator.storage.estimate()`), read just before the transaction | not applied |

**Admission,** inside the page transaction, before any write:
1. `admitPage(tx, { partitionId, blobBytes, entries, freeBytes })` checks the projected size (blobs + per-entry overhead + repair headroom) against `maxBytes` and the floor. On refusal it rejects `STORAGE_BUDGET`.
2. The page writes.
3. `accountCommit(tx, { partitionId, deltaBytes })` runs in the same transaction.

Erase calls `accountErase` in the erase transaction.

**Outcomes:**
- `STORAGE_BUDGET`: admission refused the page.
- `STORAGE_FULL`: the platform refused it (`QuotaExceededError`, ENOSPC, `SQLITE_FULL`). Nothing from the page commits or is counted.

Both stop the sync (`class: "storage"`) with the epoch unchanged. Committed content serves while it's fresh. There is no eviction.

## 5. Options, status and events

- **Options:** `ReplicationOptions` adds `grantTtlMs?`, `maxBytes?` and `minFreeBytes?`. `ResolvedReplicationOptions.grantTtlMs` stays optional until S4 wires the default.
- **Status:** `persisted?`, `purgePending?` and `gate?`; `ReplicaState` adds `gated`; `ReplicationReason` adds `replica_gated`.
- **Events:**
  - `replication.sync` adds `trigger: "peer"`, `origin?: "peer"` and `class: "lifecycle"`.
  - New `replication.grant` (§3).
  - New `replication.lifecycle`: `denied`, `deny_stale`, `deny_failed`, `database_deleted`, `marker_set`, `marker_cleared`, `unguarded`, `drained`, `erased`, `erase_failed`, `activation_blocked`, `activated` and `recovered`, with an optional `replicaId`, `reason`, `gate`, `partitions`, `remaining` and `code`.
- **Identifiers:** `replication.grant` and `replication.lifecycle` carry **no account identifiers**: no `space`, no prefix and no principal. They use only the opaque `replicaId` (browser: the salted partition id; node: the replica hash). The existing `replication.read`, `write`, `sync`, `state` and `divergence` events carry `space` and keys, as in Phase 1. That is a baseline limitation, not covered by this claim.
- **In-repo consumers updated:**
  - sdk-services `diagnostics.ts` allowlists;
  - `TelemetryEvents` (`REPLICATION_GRANT`, `REPLICATION_LIFECYCLE`);
  - the CLI `replication-log` debug output.

## Appendix: browser database layout

One IndexedDB database per origin, `REPLICA_KV_DATABASE` = `tinycloud-replica-kv`. All stores use out-of-line keys.

| Store (`REPLICA_KV_STORES`) | Owner | Key | Guarded by `run` |
| -- | -- | -- | -- |
| `meta` | adapter (S1) | `partitionId` | yes |
| `entries` | adapter | `[partitionId, key]` | yes |
| `blobs` | adapter | `[partitionId, blake3Hex]` | yes |
| `pending` | adapter | `identityKeyHash` | yes |
| `device` | adapter (deny deletes `"device"` and first-install entries) | `"device"`; `"firstInstall:" + identityKeyHash` | yes |
| `gate` | lifecycle (S3) | `"account"` | control |
| `partitions` | lifecycle | `partitionId` | control |
| `purgeIntents` | lifecycle | `ReplicaPurgeIntent.id` | control |
| `quota` | ledger (S5) | ledger-defined | control |

The adapter's schema upgrade creates every store. The RC1 per-partition databases (`tinycloud-replica/<id>`) remain for `openReplica`, untouched.
