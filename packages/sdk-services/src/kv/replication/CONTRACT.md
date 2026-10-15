# Shared replica contract (TC-858 Phase 2)

This document is normative for every `KVReplicaStorage` adapter: the browser IndexedDB adapter (`@tinycloud/replica/kv-storage`) and the node/CLI SQLite adapter (`@tinycloud/node-sdk`). Both implement the **same** interfaces. They differ only in where state is stored, and each section has "Browser" and "Node/CLI" notes for that. The types live in this directory:

| File | Contents |
| -- | -- |
| `types.ts` | storage, handle, controller, options, status and event types |
| `lifecycle.ts` | session stamp, account gate, gate and erase seams |
| `grantPolicyTypes.ts` | consent anchor, grant policy, policy function signatures |
| `quota.ts` | quota spec, page admission, ledger seam, node admit hook |
| `contractConstants.ts` | error codes, defaults, store and file names |

`contractConstants` and `grantPolicyTypes` are subpath exports (`@tinycloud/sdk-services/kv/replication/contractConstants`, `…/grantPolicyTypes`). The constants are not re-exported from the package root.

**Feature off is byte-identical.** Every addition is optional in the types. With replication off, nothing in this contract runs. With replication on:
- no `lifecycle` on the storage means no stamps and no gate checks, as in Phase 1;
- no `quota` means unbounded;
- the grant policy is **always** applied (§3). A missing `grantPolicy` means the default policy, never Phase 1's unbounded serving.

Conventions: instants are milliseconds since the Unix epoch, durations are milliseconds and sizes are bytes, unless a field says ISO string. Errors are `Error & { code: string }`, and gate refusals also carry `gate`.

## 1. `KVReplicaStorage` and handles

**Read metadata.** Every `get` and `list` result carries `LocalReadMeta`: `asOf`, `coverage`, `authority` and `syncedThroughEpoch`. `authority` is `expired` at or after the grant's `effectiveExpiresAt` when a policy is set (§3), not only after the signed `exp`.

**Grant metadata.** `grant()` and `installGrant()` return `ReplicaGrantInfo`:
- `cid`, `parentCid`, `state` (`active` | `pending`) and `unconstrained` are unchanged from Phase 1;
- `expiresAt` is the **signed** `exp`, in ms;
- `installedAt`, `effectiveExpiresAt`, `consentDeadline` and `consentAnchor` are present when `spec.grantPolicy` is set.

**Install validation.** `installGrant(ucan)`:
- rejects `GRANT_AUDIENCE_MISMATCH` unless the audience is the handle's device;
- rejects `GRANT_NOT_COVERING` unless the grant covers both `tinycloud.kv/get` and `tinycloud.kv/sync` on the prefix **with no caveats** (caveated grants are refused);
- is a guarded operation (§2).

**Sync and cancellation.** `sync({ signal, syncStartEpoch })`:
- **Abort.** Aborting `signal` stops at the last complete page. Nothing past that page commits, and the epoch does not move. The browser passes cancellation into the worker with a cancel RPC keyed by request id.
- **`close()`** cancels in-flight syncs and resolves only after they settle.
- **Epoch finalisation.** `syncStartEpoch` is persisted **in the same transaction as the sync's completion marker**, and only after the whole sync has finished: feed pages, repairs and GC. Failed, aborted and busy syncs leave the previous `syncedThroughEpoch`, including a failure after the last feed page.

**Device injection.** If `spec.device` is set, the adapter uses that device for partition naming, audience checks and signing. It never loads or mints its own device for that handle. If it's absent, the adapter uses its stored owner-minted device (browser: one per origin, in the `device` store; node: `device.jwk` per identity). `handle.deviceDid` equals `spec.device.did` when a device was injected.

**Partition id (browser).** The lowercase hex SHA-256 of the UTF-8 string `replicationIdentityKey(identity) + "\n" + prefix + "\n" + deviceDid`. It replaces RC1's `replicaIdOf`. The identity key hash used by the `pending` store and Web Lock names is the lowercase hex SHA-256 of `replicationIdentityKey(identity)`. Node/CLI keeps its existing directory layout.

**`purge(target)`** erases without opening, minting or syncing. It covers the deduplicated union of the stored device and `target.sessionDeviceDid`, and a missing stored device never skips the session-device purge. It is never gated (erasure is always allowed). Handles opened earlier reject `RESET_REQUIRED`.

**`inspectStatus(spec, { signal })`** is bounded, read-only and cancellable. It never creates a replica, never takes a mutation guard and is not gated (it carries no stamp). A missing replica returns `undefined`.

**Status additions** (on `LocalReplicaStatus`, and inherited by `ReplicaStatusEntry`):
- `persisted: boolean | null`. Browser: the result of `navigator.storage.persist()`, or `null` when unavailable or not yet asked. Node/CLI omit it.
- `purgePending: boolean`. True while a purge intent covers the partition or its identity.

**Pending writes.** `pendingWrites(identity, { stamp })` returns a durable store (`durable: true`), scoped by identity rather than by prefix. If it can't be opened, it surfaces `STORAGE_ERROR`. It never substitutes memory. With a gate configured, the store is bound to the stamp it was obtained with, and every call is a guarded operation (§2). Callers cache stores per identity **and** stamp.
- Browser: the `pending` store keyed by identity key hash. Read-modify-write is serialised across tabs with a Web Lock named `REPLICA_PENDING_LOCK_PREFIX + identityKeyHash`, and each transaction includes the `gate` and `purgeIntents` stores.
- Node/CLI: `pending.json` under the identity directory, serialised by the storage `guard` (the profile lock in the CLI). `update` re-reads the gate file inside the guard. The lock-free `read`/`readExisting` read the gate file before the pending file.

**Peer commits.** If the spec has `onPeerCommit`, the adapter calls it when **another** tab or process commits a sync for the same partition. The browser does this from the worker's `committed` message on `REPLICA_KV_CHANNEL`. It is never called for the handle's own commits, and it must not throw. The controller emits `replication.sync` with `trigger: "peer"`, `origin: "peer"` and `outcome: "ok"`, and doesn't sync.

**Error precedence** for a guarded operation: `REPLICA_GATED` first, then `RESET_REQUIRED` (the partition was erased under the handle), then `GRANT_*`, then storage and network codes.

## 2. Lifecycle and epoch gate

**State.**
- **Account gate** `ReplicaAccountGate { incarnation, principal, lifecycleEpoch }`:
  - `incarnation` is random and generated when the gate store is created. It changes whenever that store is deleted and recreated.
  - `lifecycleEpoch` is a non-negative integer. It goes up by one on every sign-out and account switch, and never goes down within an incarnation.
  - `principal` is lower-cased, and `null` after sign-out.
- **Partition index** `ReplicaPartitionIndexEntry`: every partition ever created in the gate's scope. An adapter registers a partition with `ReplicaGateTx.indexPartition` in the transaction that creates it.
- **Purge intents** `ReplicaPurgeIntent`: `partition` intents (id = `partitionId`) and `pending` intents (id = `"pending:" + identityKeyHash`). A partition with an outstanding intent is unreadable.

| | Browser | Node/CLI |
| -- | -- | -- |
| Gate, index, intents, first-install anchors | `gate` (key `"account"`), `partitions`, `purgeIntents` stores in `tinycloud-replica-kv`. `first_install` anchors live in the `device` store under key `"firstInstall:" + identityKeyHash` | `replica-gate.json` (`REPLICA_GATE_FILE`): `{ v: 1, incarnation, principal, lifecycleEpoch, intents, firstInstall }`, where `firstInstall: { [identityKeyHash]: ms }`. Written atomically (temp file + rename) under the profile lock. CLI: `<profile>/replica-gate.json`. The node-sdk storage takes a `gateFile` option that defaults next to `dir`, outside the replication data. The partition index may be derived from the on-disk layout |
| Cross-tab/process signal | `localStorage` marker `REPLICA_LOGOUT_MARKER`; BroadcastChannel `REPLICA_KV_CHANNEL` and the `storage` event | the gate file is re-read inside every guarded mutation |
| Session stamp persisted in | sdk-core `PersistedSessionData.replicaStamp` (S3 adds it to the zod schema: `incarnation: string`, `lifecycleEpoch: non-negative int`), next to the SIWE | the profile's persisted session record |

**Session stamp.** `ReplicaSessionStamp { incarnation, lifecycleEpoch }`.
- It is captured **once** when the session is established (at sign-in, or at restore of a session persisted under that stamp) with `captureSessionStamp(principal)`, and it is immutable after that.
- A session without a stamp is "not established" and is refused (`not_established`).
- The controller gets it as `KVReplicationDeps.stamp` and passes it into every `KVReplicaSpec.stamp`. A handle never adopts a newer stamp.

**Guarded operations.** These are `open`, `get`, `list`, `status`, `installGrant`, every sync page commit, the sync completion, and **every pending-store call**: `read`, `readExisting` and `update` (which covers append, settle, remove, clear and flush). Each one calls `ReplicaGateTx.assert(tx, { stamp, principal, partitionId?, identityKeyHash? })` **first, inside its own transaction** (node: inside the guarded mutation for writes), before it touches or initialises storage. The call refuses with `REPLICA_GATED` and a `gate` reason when:
- the stamp's `incarnation` or `lifecycleEpoch` differs from the gate (`stamp_stale`);
- the gate's principal is `null` or a different account (`principal_mismatch`);
- an intent covers the partition (`purge_pending`);
- the gate store can't be read (`gate_unavailable`; fail closed).

On refusal the transaction aborts: a read returns nothing and a page commits nothing. A browser adapter's transactions include the control stores. A node adapter re-reads the gate file inside its guarded mutation.

**Results when gated.**

| Operation | Gated result |
| -- | -- |
| `storage.open(spec)` | rejects `REPLICA_GATED`; creates no partition and no index entry. A spec without a stamp, given to an adapter that has a `lifecycle`, rejects with `not_established` |
| `handle.get` / `list` / `status` | rejects `REPLICA_GATED` (not a `LocalGetResult` status) |
| `handle.installGrant` | rejects `REPLICA_GATED`; nothing written |
| `handle.sync` | rejects `REPLICA_GATED`; the current page aborts and the epoch is unchanged |
| `pendingWrites(…).read` / `readExisting` / `update` | rejects `REPLICA_GATED`; nothing is read, created or written. So a stale tab, worker or process can't refill the pending state after `deny` → `eraseIdentityPending`, or before the purge on an account switch. A store obtained without a stamp rejects every call with `not_established`. **Controller:** `REPLICA_GATED` from the pending store moves the whole controller to `gated`, and it never serves locally again under that stamp. Reads go to the network with `replica_gated`. Covered writes are dispatched to the network **without** a pending record. That's safe because pending records only protect local serving, and none will happen. This differs from Phase 1's `STORAGE_ERROR` path, which refuses to dispatch. A session with no established stamp (for example B before activation) binds no controller, so its KV calls go straight to the network |
| `storage.purge`, `inspectStatus` | not gated |

`RESET_REQUIRED` is reserved for handles whose partition was **erased** (by purge or revocation) after they opened.

**Read-through when gated.** The controller treats `REPLICA_GATED` from open, read or sync as a network fallback:
- the read event has `source: "network"`, `reason: "replica_gated"` and `code: "REPLICA_GATED"`;
- status has `state: "gated"`, `gate: <reason>`;
- `replication.sync` errors have `class: "lifecycle"`.

A gated prefix is not retried on the open-backoff schedule. It stays gated until the controller is rebound with a new stamp.

**The main-thread delivery check.** `deliverable(stamp)` is synchronous. The SDK calls it before it hands any replica-served value to a caller, and before every sync request. When it returns false, the value is dropped and the read goes to the network with `replica_gated`.
- Browser: it checks the `localStorage` marker and this tab's gate view, which `deny` updates synchronously.
- Node/CLI: it checks this process's gate view.

The browser worker attaches to each reply the stamp the read ran under. The SDK drops a reply whose stamp no longer matches the handle's view.

**Sign-out and account switch** (`ReplicaLifecycleGate`), in this order:
1. **Deny and record intent.** `deny({ reason, next? })` does all of this in one commit: gate `principal` → `null` (sign-out) or `next` (switch); `lifecycleEpoch + 1`; intents for every indexed partition and pending record of the old principal; and removal of the old principal's `first_install` consent anchors (§3). It never rejects, and returns a `ReplicaDenyOutcome`:
   - `denied`: the normal path.
   - `deleted` (browser): the deny commit failed, and `indexedDB.deleteDatabase(REPLICA_KV_DATABASE)` succeeded. Every connection has an `onversionchange` handler that closes it. A recreated database gets a new incarnation.
   - `marker` (browser): the delete failed or stayed blocked, and `REPLICA_LOGOUT_MARKER` was written. The marker blocks activation for every account and delivery from every open handle. Every load retries the delete, and the marker is cleared only once the delete succeeds.
   - `unguarded`: nothing could be written, so **cross-tab denial is not guaranteed**. This tab has disabled replication in memory and serves nothing. The docs state this limitation.
2. **Drain.** This tab or process cancels and closes its handles. Other tabs are refused from their next transaction onward, and the browser nudges them over the BroadcastChannel and the `storage` event.
3. **Erase.** `erasePending({ signal })` erases each intent in **its own** transaction. That transaction runs `ReplicaPartitionEraser.erasePartition` (or `eraseIdentityPending`), `ReplicaQuotaLedger.accountErase` and `ReplicaGateTx.clearIntent` together. Only a contentless tombstone remains. An intent that fails stays outstanding, and `purgePending` stays true.
4. **Activate** (account switch only). `activationAllowed(next)` is false until **every** intent of the previous principal is erased and no marker is set. Until then, B's replication stays inactive: reads go to the network, and nothing opens or syncs. After that, `captureSessionStamp(next)`.

Sign-out alone returns once step 1 commits, and the erase continues in the background.

**`captureSessionStamp(principal)`:**
- gate principal `null` → set it to `principal`, with no epoch bump (`deny` already bumped);
- gate principal equal to `principal` → return the current stamp (tabs of one account share it);
- another account → reject `REPLICA_GATED`/`principal_mismatch` (the caller runs `deny({ reason: "account_switch", next })` first);
- outstanding intents → reject `purge_pending`.

**Startup.** `recover({ signal })` runs before anything binds:
- browser: the pending delete first, if the marker is set;
- then the erase of every outstanding intent.

It never rejects. Remaining intents show as `purgePending` and in `pendingPurge()`.

**Node/CLI difference (location only).** The protocol is the same. Without a configured gate (`lifecycle` absent), node-sdk keeps its Phase 1 behaviour: it unbinds, and data stays on disk until `purge()`.

## 3. Grant duration and renewal

**Policy inputs.** `ReplicationOptions.grantTtlMs`:
- defaults to `DEFAULT_GRANT_TTL_MS` (24 h);
- `≤ 0` or above `MAX_GRANT_TTL_MS` (7 d) is a `TypeError` at construction.

The controller passes `KVReplicaSpec.grantPolicy = { grantTtlMs, consentAnchor }`. **With replication enabled, the policy is required.** The controller always sets it. An adapter given a spec without it applies the default policy (`DEFAULT_GRANT_TTL_MS`, anchor `null`), never unbounded serving. "Absent policy = Phase 1" applies only when replication is off. The field stays optional in the type only so Phase 1 callers still compile.

**Consent anchor** (`ReplicationAuthority.consentAnchor()`), in fallback order:
1. the SIWE `issuedAt` of the sign-in that granted replication (`siwe`);
2. for compact delegated sessions, the delegation's `iat` (`delegation_iat`);
3. then its `nbf` (`delegation_nbf`);
4. otherwise `null`. Storage then uses its persisted first-install time (`first_install`), persisting it on the first install, and reports it in `ReplicaGrantInfo.consentAnchor`.

**Anchor invariants:**
- `at` is finite milliseconds.
- Second-based sources (UCAN `iat`/`nbf`) are converted ×1000 **exactly once**, at the authority.
- Every anchor goes through `clampConsentAnchor(anchor, now)`, which clamps `at` to ≤ now and returns `null` for a non-finite `at`. On `null`, the next source in the order is used.
- Renewals never re-anchor. Only a fresh sign-in gives a new anchor.
- A `first_install` anchor is keyed by identity (`identityKeyHash`). It **survives** partition reset, purge, revocation and reinstall, and is cleared **only by `deny`**, because signing in again is fresh consent. It is stored in the node gate file's `firstInstall` map, or in the browser `device` store (§2).

**Consent deadline** = `consentDeadlineMs(anchor)` = `anchor.at + CONSENT_WINDOW_MS` (7 d).

**Effective expiry.** It is computed as

```
effectiveGrantExpiry({ signedExpiresAt, installedAt, grantTtlMs, consentDeadline })
  = min(signedExpiresAt ?? ∞, installedAt + grantTtlMs, consentDeadline)
```

**`installedAt`** is taken from the storage clock at the **first** install of that grant CID. Re-installing the same CID doesn't refresh it, and recompute-at-open uses the stored value.

The adapter stores the effective expiry with the installed grant and **recomputes it at open** from the stored `installedAt` and the current `spec.grantPolicy`, which caps a grant restored from an older policy. It is checked inside the read transaction, alongside node-attested authority, and whichever ends first wins.

**Serve checks fail closed:**
- Serving requires `now < effectiveExpiresAt` and `now < consentDeadline`. Every check is written as a refusal on `!(now < bound)`, so `NaN` refuses.
- A stored bound that is missing (with replication enabled) or not finite (`NaN`, `±Infinity`) also refuses.
- When a check refuses, `LocalReadMeta.authority` is `expired`, and reads go to the network with `grant_expired`. The code is `GRANT_EXPIRED`, or `CONSENT_EXPIRED` when the deadline is what refused.
- Expiry blocks reads; it does not erase.

**Clock rollback is an accepted risk for Phase 2.** Local bounds use `Date.now()`, so a device clock set backwards extends local serving of bytes already copied. The signed `exp` still bounds every **network** use (sync, renewal), because the node enforces it.

**Every grant path:**

| Path | Rule |
| -- | -- |
| Fresh mint | `mint(deviceDid, prefix, signal, { expiryMs })` with `expiryMs = mintRemainingMs({ now, grantTtlMs, consentDeadline }) = min(grantTtlMs, consentDeadline − now)`. `expiryMs` is a **duration**, forwarded as `delegateTo(device, entries, { expiry: expiryMs })`. No mint when `expiryMs ≤ 0` (`CONSENT_EXPIRED`) |
| Session grant reused directly | installed only if its effective expiry is within policy. Otherwise it's replaced by a derived capped grant where the authority can derive (`canRenew`), or installed with the effective expiry enforced locally (`replication.grant` `capped`) |
| Compact delegated / `sessionOnly` | effective expiry enforced locally; `canRenew` is false, so there is no silent renewal |
| Installed grant reused at open | only if the stored `effectiveExpiresAt` is ahead and `now < consentDeadline` |
| Grant restored from an older policy | effective expiry recomputed at open; capped locally |

**Silent renewal.** `needsSilentRenewal({ now, installedAt, effectiveExpiresAt, consentDeadline })` is true when `effectiveExpiresAt − now < RENEW_BELOW_FRACTION × (effectiveExpiresAt − installedAt)`, **strictly** below (exactly 25% remaining does not renew), and `now < consentDeadline`. It returns false for non-finite inputs.
- **When it's checked:** on a timer, before each sync, and at open.
- **How it renews:** only through the session-key derivation path of `delegateTo`, never the wallet path. Renewal must not prompt.
- **On refusal or offline:** the current grant keeps serving until its effective expiry.

**Events** (`replication.grant`): `minted`, `renewed`, `renewal_refused` (with `code`), `renewal_deferred` (offline, or the authority can't derive), `capped`, `expired`, and `consent_deadline_reached` (`code: "CONSENT_EXPIRED"`). They carry ISO `effectiveExpiresAt` and `consentDeadline`, and `expiryMs` for mints.

**After the deadline:** no mint and no renewal, and local reads stop. Network reads continue. Re-consent is a fresh sign-in, which gives a new anchor.

S4 implements `effectiveGrantExpiry`, `consentDeadlineMs`, `mintRemainingMs`, `needsSilentRenewal` and `clampConsentAnchor` in `grantPolicy.ts`, with the signature types in `grantPolicyTypes.ts` and the constants in `contractConstants.ts`.

## 4. Quota

**Options.**
- `ReplicationOptions.maxBytes`: absent means unbounded.
- `ReplicationOptions.minFreeBytes`: browser only, defaulting to `DEFAULT_MIN_FREE_BYTES` (64 MiB).

The runtime forwards both as `KVReplicaSpec.quota`.

| | Browser | Node/CLI |
| -- | -- | -- |
| Budget scope | origin-wide, across every partition in `tinycloud-replica-kv` | per profile (per storage `dir`) |
| Ledger | `quota` control store, updated inside the page-commit and erase transactions | computed inside `applyPage`'s guarded mutation |
| Seam | `ReplicaQuotaLedger<IDBTransaction>` | `ReplicaAdmitHook`, as the optional `admit` option of the SQLite store |
| Free-space floor | `freeBytes()` from `navigator.storage.estimate()`, read just before the transaction; best effort | not applied |

**Admission.** For each page, inside the page's own transaction, before any write:
1. `admitPage(tx, { partitionId, blobBytes, entries, freeBytes })`. The ledger projects blob bytes, plus the measured per-entry overhead, plus repair headroom, against `maxBytes`, and checks `freeBytes` against the floor.
2. If it refuses, it rejects with `STORAGE_BUDGET`, and the transaction aborts.
3. Otherwise the page writes, and then `accountCommit(tx, { partitionId, deltaBytes })` runs in the same transaction.

Erase calls `accountErase(tx, { partitionId, bytes })` in the erase transaction.

**Outcomes.**
- `STORAGE_BUDGET`: admission refused the page.
- `STORAGE_FULL`: the platform refused it (`QuotaExceededError`, ENOSPC, `SQLITE_FULL`). The transaction aborts, and nothing from that page is committed or counted.

Both stop the sync with that code (`replication.sync`, `outcome: "error"`, `class: "storage"`). The epoch doesn't move, committed content stays, and covered keys are served while they're fresh.

There is no eviction. To shrink, purge and sync a narrower prefix.

## 5. Options, status and events

**`ReplicationOptions`** adds `grantTtlMs?`, `maxBytes?` and `minFreeBytes?`.

`ResolvedReplicationOptions.grantTtlMs` stays optional until S4 wires the default.

**Status:**
- `LocalReplicaStatus` adds `persisted?` and `purgePending?`;
- `ReplicaStatusEntry` adds `gate?`;
- `ReplicaState` adds `gated`;
- `ReplicationReason` adds `replica_gated`.

**Events:**
- `replication.sync` adds `trigger: "peer"`, `origin?: "peer"` and `class: "lifecycle"`;
- `replication.grant` is new (§3);
- `replication.lifecycle` is new: `denied`, `deny_failed`, `database_deleted`, `marker_set`, `marker_cleared`, `unguarded`, `drained`, `erased`, `erase_failed`, `activation_blocked`, `activated` and `recovered`, with an optional `reason`, `gate`, `partitions`, `remaining` and `code`.

Lifecycle and grant events **never carry a principal**.

## Appendix: browser database layout

One IndexedDB database per origin, `REPLICA_KV_DATABASE` = `tinycloud-replica-kv`. Every store uses out-of-line keys (no `keyPath`, no autoIncrement).

| Store (`REPLICA_KV_STORES`) | Owner | Key |
| -- | -- | -- |
| `meta` | adapter (S1) | `partitionId` |
| `entries` | adapter | `[partitionId, key]` |
| `blobs` | adapter | `[partitionId, blake3Hex]` |
| `pending` | adapter | `identityKeyHash` |
| `device` | adapter (first-install entries cleared by `deny`) | `"device"`; `"firstInstall:" + identityKeyHash` |
| `gate` | lifecycle (S3) | `"account"` |
| `partitions` | lifecycle | `partitionId` |
| `purgeIntents` | lifecycle | `ReplicaPurgeIntent.id` |
| `quota` | ledger (S5) | ledger-defined |

The adapter's schema upgrade creates every store. The RC1 per-partition databases (`tinycloud-replica/<id>`) remain for the explicit `openReplica` API, untouched.
