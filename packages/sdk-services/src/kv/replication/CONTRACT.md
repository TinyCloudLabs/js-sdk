# Shared replica contract (TC-858 Phase 2), rev 3

This document is normative for every `KVReplicaStorage` adapter: the browser IndexedDB adapter (`@tinycloud/replica/kv-storage`) and the node/CLI SQLite adapter (`@tinycloud/node-sdk`). Both implement the **same** interfaces. They differ only in where state is stored and how a transaction is realised, and each section has "Browser" and "Node/CLI" notes for that. The types live in this directory:

| File | Contents |
| -- | -- |
| `types.ts` | storage, handle, controller, options, status and event types; `ReplicaGatedStorage`, `ReplicaGatedSpec` |
| `lifecycle.ts` | session stamp, account gate, `ReplicaGateTx.run`, erase seam, lifecycle facade |
| `grantPolicyTypes.ts` | consent anchor, grant policy, policy function signatures |
| `quota.ts` | quota spec, page admission, ledger seam, node admit hook |
| `contractConstants.ts` | error codes, browser storage names, free-space default; re-exports grant numeric constants |
| `grantPolicyConstants.ts` | single source for grant TTL, consent window and renewal threshold, with no browser storage identifiers |

`contractConstants`, `grantPolicyConstants` and `grantPolicyTypes` are subpath exports (`@tinycloud/sdk-services/kv/replication/contractConstants`, `…/grantPolicyConstants`, `…/grantPolicyTypes`). Runtime policy and config import the numeric-only subpath so the default web bundle does not include browser database, marker or control names. The existing `contractConstants` export keeps the same named values for adapter consumers. None are re-exported from the package root.

**Only replication off is byte-identical.** With replication off, nothing in this contract runs. With replication on, everything here is mandatory:
- the lifecycle gate (§2);
- the session stamp;
- the grant policy (§3).

The new fields are optional in the Phase 1 types only so existing callers and test doubles compile. Phase 2 adapters use `ReplicaGatedStorage` and `ReplicaGatedSpec`, which require them.

**Source compatibility.** This is **not** a source-compatible change for exhaustive consumers. `ReplicaState` (`gated`), `ReplicationReason` (`replica_gated`), `ReplicationEvent` (`replication.grant`, `replication.lifecycle`), the sync `trigger` (`peer`) and `class` (`lifecycle`) all gain members. Replication is pre-GA (beta), and the break is accepted.

Conventions:
- Instants are milliseconds since the Unix epoch, durations are milliseconds and sizes are bytes, unless a field says ISO string.
- Errors are `Error & { code: string }`. Gate refusals also carry `gate`.

### Browser at-rest threat model

**In scope:** a raw scan of **replica-owned** `tinycloud-replica-kv` IndexedDB
stores, their secondary index keys and replica-owned origin localStorage keys
MUST find no literal value content, KV keys, path prefixes, device DIDs or
account identifiers. Blobs, entries, pending state and sensitive meta fields
are AES-GCM-sealed; searchable IDs use nonextractable private HMAC keys (§1).
The adapter enforces `allowSecrets === false` and rejects secrets/vault prefixes **and root `/`**, which
could include them, in the package itself. A stale tab after deny or account switch is
fenced before replica delivery. Browser sign-out, switch and 7-day consent expiry delete
account and gate keys before background purge, making stranded ciphertext unavailable to
a **fresh page/worker** with no old CryptoKey reference.

**Baseline exemption:** the pre-existing web-sdk `BrowserSessionStorage` stores the address,
signed SIWE and session-key JWK in origin Storage (`sdk-core/storage.schema.ts`,
`web-sdk/BrowserSessionStorage.ts`). A signed-in session can be restored without a wallet
prompt; those non-replica keys/records are explicitly outside the replica raw scan.

**Out of scope:** an attacker who reads the browser profile while that signed-in session
is valid can also obtain the persisted session and its usable key; nonextractable IDB
`CryptoKey`s are NOT guaranteed protected from a raw browser-profile reader, nor can a
previously retained in-memory CryptoKey be revoked. Same-origin hostile JS with an active
session, OS/browser compromise and an offline profile dump are not claims of confidentiality
beyond the signed-in-session baseline. Use OS disk encryption. Post-GA P3 may offer an
opt-in user/hardware-bound locked copy; it is not part of TC-858 Phase 2.

**Replica-owned localStorage:** only `REPLICA_LOGOUT_MARKER =
"tinycloud-replica:logout-pending"` (numeric timestamp marker),
`REPLICA_DENY_TOMBSTONE = "tinycloud-replica:deny-tombstone"` (numeric
`{epoch, deniedAt}`), and the transient `:probe` suffix while testing writability. No
account, prefix, key or ciphertext is stored there. The tombstone persists through
crypto-shred; it is not an encryption key. A failed key-deletion transaction falls back
to database deletion or the logout marker; the marker blocks all replica serving and
reports that shredding has not been proven.

**Acceptance observation:** S6 scans all replica-owned IDB stores and the keys above. To
prove crypto-shred it leaves a ciphertext row stranded, closes the old page/worker and
drops old CryptoKey references, then opens a **fresh page/worker in the SAME
BrowserContext and origin** (not a new isolated context). The stranded ciphertext must
remain, `device["accountKey"]` and `device["gateHmac"]` must be absent, and the new
page cannot decrypt it. On switch, newly generated keys must fail AES-GCM authentication
on the old ciphertext. This proves durable-state shredding, not revocation of keys already
retained by hostile live JavaScript.

## 1. `KVReplicaStorage` and handles

**Reads never return unauthorised data.** `get` and `list` run through `ReplicaGateTx.run` (§2). Adapters MUST NOT return value bytes or list keys unless the **effective authority** is `valid`. That covers:
- the signed `exp`;
- the effective expiry;
- the consent deadline;
- node-attested authority;
- revocation.

Otherwise they throw `GRANT_EXPIRED`, `GRANT_REVOKED`, `GRANT_NOT_YET_VALID` or `CONSENT_EXPIRED` inside the read transaction. The controller then falls through to the network with the matching reason (`grant_expired`, `grant_revoked` or `grant_not_yet_valid`).

Results carry `LocalReadMeta` (`asOf`, `coverage`, `authority`, `syncedThroughEpoch`). `authority` is therefore always `valid` on a returned result.

**Opaque handle identifier.** With replication on, `ReplicaGatedStorage.open`
returns `ReplicaGatedHandle` with an immutable required `replicaId`: browser
private gate-HMAC `partitionId`, node replica hash. It also preserves the
immutable `ReplicaGatedSpec.stamp` and required grant policy. Phase 1
`KVReplicaHandle.replicaId?` remains optional. The controller never fabricates
an id from space/prefix/principal or emits a `replication.grant` event before
it has an opened handle's opaque id.

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

**Identifiers and keys.** Browser `gateHash(key, domain, material)` is lowercase-hex
HMAC-SHA-256 of UTF-8 `${domain}\0${material}`, keyed by the **nonextractable**
per-incarnation `device["gateHmac"].hmac`, never the public gate `salt` alone.
Domains are `principal`, `identity`, `partition` and `lookup`:
- `principalHash`: `gateHash(key, "principal", lowerCasePrincipalDid)`;
- `identityKeyHash`: `gateHash(key, "identity", replicationIdentityKey(identity))`;
- `partitionId`: `gateHash(key, "partition", replicationIdentityKey(identity) +
  "\n" + prefix + "\n" + deviceDid)`;
- `lookupId`: `gateHash(key, "lookup", replicationIdentityKey(identity) +
  "\n" + prefix)`, **independent of the sealed owner device DID**.

`lookupId` maps to one or more opaque partition IDs; `ownerDevice` distinguishes
the adapter-owned device (`spec.device === undefined`) from injected devices.
Events use `partitionId` as `replicaId`. Before account establishment the gate
key can name the account without account content keys; after denial it is
deleted, while intents/index entries retain only the already-derived ids
needed for erasure. Web Lock names use private hashes. Node/CLI's
`SaltedHash(salt, material)` remains lowercase-hex HMAC-SHA-256 with the
base64url-decoded per-incarnation salt for principal hashes. Node's existing
unsalted SHA-256 base32 identity directory name remains a known node exposure.

**Browser key hierarchy** (`device` store, no raw key exports):
- `device["gateHmac"] = { v: 1, incarnation, keyId, hmac }`, with a 128-bit random `keyId`
  and nonextractable HMAC-SHA-256 `CryptoKey`;
- `device["accountKey"] = { v: 1, incarnation, lifecycleEpoch, principalHash, keyId,
  aesGcm, hmac }`, with a separate nonextractable AES-GCM-256 `CryptoKey` and
  nonextractable HMAC-SHA-256 `CryptoKey` for account path/hash/CID indexes.

The gate key is generated with a new gate (or freshly after denial); account keys are
generated only with verified fresh establishment and committed with the active gate. A
restored session may use them only if incarnation, epoch, principalHash and keyId match;
missing/mismatched keys fail closed (`REPLICA_GATED`, `gate_unavailable`), never regenerate
from a restored stamp. Both records are deleted on every deny/switch/consent expiry
**before** background purge; new keys are generated only after old intents drain and
fresh consent establishes. Nonextractable IDB keys block direct JS export, **not** a raw
browser-profile reader (§ Browser at-rest threat model).

**Browser transaction order.** WebCrypto awaits never occur after opening an IDB
transaction: `snapshot()` first → derive gate/account HMAC identifiers and AES-seal
payloads **outside** any transaction → `run(scope, access, fn)`. The first IDB request
reads the gate and checks incarnation, stamp, keyId, consent deadline and precomputed
principal hash before `fn`. A mismatch aborts with no writes. No raw identity, path,
prefix, value, grant, or owner JWK enters a replica-owned data/control row.

**`purge(target)`** erases without opening, minting or syncing:
- browser derives `lookupId` and target principal hash from the current gate
  key snapshot **outside** an IDB transaction, then rechecks
  incarnation/keyId/principal hash in the erase transaction and selects
  owner-device rows plus the exact partition ID for
  `target.sessionDeviceDid` if supplied; other injected-device partitions
  are never erased by this targeted purge. Node uses its stored owner device
  plus the provided session device, with the same deduplicated semantics;
- erasure itself is exempt from the serving gate. After deny/key shred,
  replay uses stored opaque intents/index IDs, never regenerating a key or
  decrypting the sealed device to find an owner. A missing key with existing
  unknown partitions fails closed rather than falsely reporting purge;
- erasing a partition removes its index entry. Handles opened earlier reject
  `RESET_REQUIRED`, detected by tombstone/generation, not unlinking (POSIX
  keeps unlinked files readable).

**`inspectStatus(spec, { signal })`** is bounded, read-only and cancellable,
never creating storage. It is **ungated** (no stamp), a known metadata
exposure. Browser derives the opaque `lookupId` from a current private gate
key snapshot outside the transaction; its inspection read transaction
rechecks incarnation/keyId **before** using `byLookupId`, then selects only
`ownerDevice`. It MUST NOT acquire the account key or decrypt. With no gate
key after deny, or a changed snapshot, it returns `undefined`, not a
fabricated status or newly minted key. Otherwise it returns
`ReplicaInspectedStatus { redacted: true }` with opaque control
counts, bytes, coverage and epoch only, omitting grant/authority/errors;
node/CLI may return a full `LocalReplicaStatus` with existing grant CIDs/times.
Neither returns values, plaintext keys, prefixes or account identifiers.
Controller status preserves `redacted` and never infers `ready` or `revoked`
from it; unknown is not `null`/absent.

The browser branch maps only `meta.coverageCode`, `syncedThroughEpoch`,
`keys/contentMissing/tombstones` and `contentBytes` to those fields (§4);
`purged` and `generation/revision` remain opaque controls, never a guessed
authority state.

**Status additions:**
- `persisted: boolean | null`. Browser: `navigator.storage.persist()`; node omits it.
- `purgePending: boolean`.

**Pending writes.** `pendingWrites(identity, { stamp })` returns a durable store (`durable: true`) scoped by identity. On an open failure it surfaces `STORAGE_ERROR` and never substitutes memory.
- The store is bound to its stamp, and callers cache stores per identity **and** stamp. With a gate, no stamp is `REPLICA_GATED` (`not_established`).
- Every `read`, `readExisting` and `update` (append, settle, remove, clear, flush) checks the gate **before accessing the pending file or store**. Deny makes an in-flight flush fail closed.
- **Browser:** the `pending` store is keyed by **private gate-HMAC**
  `identityKeyHash`. Its `update(mutate)` closure runs on the **main thread**, so the
  pending store uses a main-thread `ReplicaGateTx` (§2). Read-modify-write is serialised
  across tabs:
  1. `snapshot()` obtains the current key record and incarnation before any transaction;
  2. derive `identityKeyHash` asynchronously outside a transaction;
  3. take the Web Lock `REPLICA_PENDING_LOCK_PREFIX + identityKeyHash`;
  4. `run` re-checks incarnation, stamp and keyId **as its first IDB request** before
     reading or mutating the pending row.

  A changed key, incarnation or stamp fails closed (`stamp_stale`); no raw identity appears
  in the Web Lock name. If `navigator.locks` is absent or its request fails, no update
  occurs: `REPLICA_GATED` (`gate_unavailable`), never an unlocked fallback.
- **Node/CLI:** `pending.json` under the identity directory is **not** a SQLite store. Both `read` and `readExisting`, including a missing file, take the mandatory profile lock, validate the gate, pending intent and identity generation, then read the file while still locked. `update` takes the same lock across gate check, identity verification, read, mutation, atomic temp-file write, rename and durability sync; no directory/file is created before the check. In-process update queues serialize before acquiring the profile lock. The lock is required when replication is on; a missing/unavailable lock fails closed (`gate_unavailable`), never silently falls back to single-process locking. Deny and pending erase take this same lock. See the node file tombstone ordering in §2.

**Peer commits.** `spec.onPeerCommit` is called when **another** tab or process commits a sync for the partition (browser: the worker's `committed` message on `REPLICA_KV_CHANNEL`). It is never called for the handle's own commits, and it must not throw. The controller emits `replication.sync` with `trigger: "peer"` and `origin: "peer"`, and does not sync.

**Error precedence:** `REPLICA_GATED` for an already denied/stale stamp; an active browser consent deadline reaches `CONSENT_EXPIRED` before `GRANT_EXPIRED`; then `RESET_REQUIRED` for erased handles, other `GRANT_*`, storage and network codes. The typed deadline transition (§2) is observable even if the timer denies before an adapter read.
**Node/CLI root capability precedence:** locally decidable `/` configuration errors precede the replica gate, but `kv-sync-root` support requires the node's `/info` and MUST NOT be queried before a deliverable stamp; without an established stamp status is `gated`/`not_established`, and only after the gate permits network access may an unsupported node report `unavailable`/`REPLICATION_ROOT_UNSUPPORTED`.

## 2. Lifecycle and epoch gate

### State

**Account gate** `ReplicaAccountGate` stores incarnation, a private gate-key identifier,
principal hash, lifecycle epoch, deniedAt and browser consent deadline. It holds no plaintext
principal. Node retains a random public salt for its existing hash/layout (a known node
exposure); browser private HMAC key records are in `device` (§1).
- `incarnation` and browser gate key are random, created with the gate store and replaced
  when it is recreated. The account keys are minted only on a verified fresh establishment.
- Browser `lifecycleEpoch` has an origin-wide floor outside the deletable database. Each
  committed deny advances it by one, including a deny whose IDB commit fails and falls back
  to database deletion. Node/CLI epochs never decrease within an incarnation.
- `deniedAt` never decreases: browser deny uses `max(now(), previous deniedAt + 1)`.
- Browser `consentDeadline` is a **durable finite millisecond instant** computed as the verified
  fresh consent anchor + `CONSENT_WINDOW_MS` at establishment. It is required when the gate
  has an active principal, never refreshed by restore, renewal or same-principal establish;
  any earlier effective consent deadline observed at install lowers it. An absent, malformed
  or non-finite active deadline fails closed. Deny clears it only after the expiry decision
  and associated key deletion commit. Node's existing SIWE clock path is unchanged.

**Partition index** `{ partitionId, principalHash, identityKeyHash, lookupId,
ownerDevice, createdAt }`. Browser ids are private gate-HMAC outputs; only
`ownerDevice` is a nonsecret boolean. The nonunique `byLookupId` index maps
an opaque identity+prefix target to one or more stored partition ids without
persisting the raw principal, prefix or device DID. `indexPartition` registers
each partition inside the `run` transaction that creates it;
`unindexPartition` removes it in the erase transaction.

**Purge intents** are `partition` intents (id = `partitionId`) and `pending` intents (id =
`"pending:" + identityKeyHash`), each carrying the stored opaque `principalHash`. A
partition or identity with an outstanding intent is unreadable.

| | Browser | Node/CLI |
| -- | -- | -- |
| Gate, index, intents | `gate` (key `"account"`), `partitions`, `purgeIntents` stores in `tinycloud-replica-kv`; gate carries opaque hashes/keyId and durable consent deadline, no raw principal | `replica-gate.json` (`REPLICA_GATE_FILE`): `{ v: 1, incarnation, salt, principalHash, lifecycleEpoch, deniedAt, intents, firstInstall, grantInstall, pendingGenerations, eraseDeferred, deferredPrincipalHash }`, where `principalHash` is `SaltedHash` hex, `grantInstall: { [grantInstallHash]: ms }` keeps each grant's first install time under a salted identity+CID hash (64 hex, never a raw CID), and `pendingGenerations: { [identityKeyHash]: non-negative integer }` persists pending-file tombstone generations. Written atomically (temp file + rename) under the profile lock. CLI: `<profile>/replica-gate.json`. The node-sdk `gateFile` option defaults next to `dir`, outside the replication data. The index may be derived from the on-disk layout |
| First-install anchors | `device` store, key `"firstInstall:" + identityKeyHash` | the gate file's `firstInstall: { [identityKeyHash]: ms }` |
| Cross-tab/process signal | `localStorage` marker `REPLICA_LOGOUT_MARKER`; durable `REPLICA_DENY_TOMBSTONE`; BroadcastChannel `REPLICA_KV_CHANNEL`; the `storage` event | the gate file, checked by `run` |
| Session stamp persisted in | sdk-core `PersistedSessionData.replicaStamp` (S3 adds it to the zod schema: `incarnation: string`, `lifecycleEpoch: non-negative int`), next to the SIWE | the profile's persisted session record |

**Node/CLI deferred marker.** `eraseDeferred: boolean` and
`deferredPrincipalHash: string | null` are gate-file fields; older v1 gate
files without them read as `false` and `null`. A malformed combination fails
closed. A deferred denial stores the original salted principal hash while
clearing `principalHash`; after resume the deferred hash remains only to
recognize an idempotent same-token retry. A new establishment clears it.

**Browser deny floor.** `REPLICA_DENY_TOMBSTONE = "tinycloud-replica:deny-tombstone"` holds
`{"epoch": <positive safe integer>, "deniedAt": <non-negative safe integer ms>}` in origin
`localStorage`. The origin Web Lock `tinycloud-replica-kv:gate` serializes establish, deny and
startup recovery; without `navigator.locks`, no mutation runs. Under the lock, each mutation
re-reads the gate and tombstone. Deny synchronously writes the next floor **before** the IDB
deny transaction or fallback `deleteDatabase`. A new gate after deletion uses a new
incarnation and gate-HMAC key but starts at `tombstone.epoch`, with `deniedAt` preserved.
Establish compares a finite, independently verified consent anchor (§3), in milliseconds and without rounding
down, strictly after the maximum of gate and tombstone `deniedAt`. An absent tombstone is
valid only before the first deny; unreadable, unwritable or malformed storage, a denied
gate with a missing floor, or a gate behind the tombstone epoch fails closed
(`gate_unavailable`). Restore and delivery also consult the floor.
When the tombstone advances, old in-memory stamps are not deliverable in any tab, even
before IDB deletion completes.

**Node deny floor.** `replica-deny-floor.json` beside the gate file holds
`{"epoch": <positive safe integer>, "deniedAt": <non-negative safe integer ms>}` (0600, atomic
rename). Deny writes it **before** the gate-file rewrite and advances past both the gate and the
floor: the new epoch is `max(gate.lifecycleEpoch, floor.epoch) + 1` and the new `deniedAt` is
`max(now, gate.deniedAt + 1, floor.deniedAt + 1)`. An absent floor is valid only before the first
deny. After a deny, a missing gate file is never recreated, and a malformed floor fails closed
(`gate_unavailable`).

**Floor-lagging gate.** A gate is *floor-lagging* when both files parse and the gate's
`lifecycleEpoch` is below `floor.epoch`, or its `deniedAt` is null or below `floor.deniedAt`.
Ordinary reads, restore, establishment and logout preflight see it as `gate_unavailable`. It
means a deny was interrupted between its floor write and its gate write (or an older gate file
was restored over a newer floor). Completing that deny is the recovery path; nothing bypasses
it. Under the profile lock, the next `tc auth logout` (plain or `--revoke`) completes it before
anything else: it writes a new floor at `max(gate.lifecycleEpoch, floor.epoch) + 1` (with
`deniedAt` past both), then rewrites the gate at that epoch and `deniedAt`, in that order.
- **Active principal** matching the logout principal: this is the interrupted deny itself, with
  the full scoped intents and generation fences. Deferral comes from the durable logout marker,
  never from the command's flags: a remote-pending v1 marker completes a deferred
  (`eraseDeferred`) deny; a plain v1 marker completes an ordinary deny; with **no** marker the
  completion is an ordinary deny and logout continues on the inactive-gate (v3) path. Under
  `--revoke` with no marker, that completion and the v3 `remotePending` marker are written in
  **one** profile-locked section, so nothing can come between them.
- **Null principal:** it only raises the epoch and `deniedAt`; principal, intents and deferral
  fields are kept, and logout continues on the inactive-gate (v3) path.
- **A different active principal:** completion is refused (`stale`) and nothing is written to the
  gate or floor. The logging-out account's own credentials are still cleared, as in "Logout
  by another account" (§ Sign-out).

A crash between the two writes leaves a floor-lagging gate again, and the next attempt repeats
the completion; a gate that is no longer floor-lagging is never touched by it. The normal
deny-first logout then continues and clears the credentials (§ Sign-out). The CLI names the
state, for example "a previous sign-out was interrupted; re-running `tc auth logout` completes
it", and re-running `tc auth logout` is the user-visible recovery.

**Recovery from a missing gate:** network access is unaffected, but local replicas stay disabled
for that profile.
`tc replica reset --replica <name> --purge` removes only a named replica and does not rewrite the
gate, so the route is a fresh profile: `tc profile delete <name>`, then sign in again. The CLI
refuses to delete the default profile, so switch the default first (`tc profile switch <other>`).
The refusal message names this route.
**Deleting both files:** if both `replica-gate.json` and `replica-deny-floor.json` are deleted, the
profile is indistinguishable from first use and a new gate is created. Its fresh incarnation makes
every older persisted stamp stale, and a new stamp still requires `establishSessionStamp` from a
fresh interactive sign-in with an independently verified finite-expiration owner SIWE (§3); restore
never establishes one. What is lost with the files is the `deniedAt` floor, the check that this
SIWE was issued after the last sign-out.

**The gate is mandatory with replication on.**
- `indexedDbReplicaStorage()` MUST expose `lifecycle`, and the web runtime refuses storage without it with `RUNTIME_UNSUPPORTED`.
- `sqliteReplicaStorage()` exposes it by default.
- With `lifecycle` present, a missing `deps.stamp` makes the controller `gated` (`not_established`) and it never opens.
- A missing `spec.grantPolicy` makes the adapter reject `open` with `REPLICA_INVALID_ARGUMENT`.

**Construction boundary (browser).** A `ReplicaGateTx` is constructed alongside whichever context **owns the transaction**. Both instances open the same origin database:
- **Worker:** replica open, reads, page commits, repair, GC and erase. It is built together with `ReplicaPartitionEraser` and `ReplicaQuotaLedger` via `createKvWorkerHost({ gateTx, ledgerFor })`.
- **Main thread:** the pending store, whose `update(mutate)` closure runs there.

No `IDBTransaction` and no closure ever crosses postMessage. `ReplicaLifecycleGate` is the main-thread facade.

**Node/CLI locking:** the profile lock is mandatory for lifecycle mutations and every guarded
mutation, including pending JSON. Missing or unavailable locking fails closed
(`REPLICA_GATED`, `gate_unavailable`); the Phase 1 optional `guard`/single-process path is
never selected with replication on.

### Session stamp

`ReplicaSessionStamp { incarnation, lifecycleEpoch }` is bound to one session object for its whole life.
- **Fresh interactive sign-in only:** `establishSessionStamp(principal, { consentAnchor })`.
  The required anchor is finite and clamped at capture: an independently verified signed
  owner SIWE `issuedAt` with a full-session KV get+sync capability witness (§3),
  or the **oldest owner-authorizing proof's** signed `iat` then `nbf` in an independently
  verified compact chain. A child leaf freshly minted from a pre-deny owner grant is **not**
  fresh owner consent; its `iat`/`nbf` must not reset the anchor. Leaf signature, CID, audience and
  space checks alone do not prove owner consent; an arbitrary did:key leaf with empty `prf`
  cannot establish. The current compact fixture's `nbf=0` is not a post-deny freshness proof.
  Never derive establishment from an unverified JWT claim, local receipt time, `Date.now()` or
  `first_install` storage fallback. A session lacking the proof or finite anchor is
  `REPLICA_GATED` (`not_established`): replication remains off and KV uses the network; no SIWE
  is invented. A restored session with a matching persisted stamp instead uses restore.
  1. Rejects `logout_pending` or `purge_pending` **before any gate mutation**.
  2. Rejects `not_established` for missing proof, absent/non-finite/`first_install` anchors;
     rejects `stamp_stale` when `consentAnchor.at ≤ max(gate.deniedAt, browser
     tombstone.deniedAt)`. A pre-deny credential cannot establish after deny or database
     deletion. Clock rollback remains the accepted Phase 2 risk (§3).
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

  **Browser restore needs a wallet provider.** The web-sdk wrapper admits a restored stamp only when the connected wallet account matches the stamp principal, read silently through `eth_accounts` (a read-only provider whose signing methods throw is enough). With replication configured and **no** provider the restore stays fail-closed and the replica is gated with `wallet_provider_required`; a provider with no connected account stays `gate_unavailable`, another account `principal_mismatch`.

A refused, stale, missing or malformed stamp gates **only the replica**: the
controller constructor must not throw on that refusal. Network-valid
`signIn()` and session restore continue under their existing rules; replica
get/list fall back to the network with `REPLICA_GATED`. No replica-only
refusal forces a fresh sign-in or wallet prompt. Restore never establishes
or repairs a stamp; only a new fresh interactive sign-in can establish one,
never rebinding an existing controller.

### The structural guard: `ReplicaGateTx.run`

**Rule:** every **session-bound** transaction that reads or writes a data store
(`meta`, `entries`, `blobs`, `pending`, `device`) MUST go through
`run(scope, access, fn)`. This includes:
- open, get, list, status and `grant()`;
- `installGrant`;
- every page commit, repair batch and GC pass;
- sync completion;
- every pending-store `read`/`readExisting`/`update`.

Only these **narrow** operations are exempt: purge/erase transactions; a
pre-transaction `snapshot()` of the gate/private gate-key control records; and
bounded ungated read-only `inspectStatus` (§1), which uses the private-key
snapshot to recheck incarnation/keyId before reading `byLookupId` and the
outer opaque/numeric `meta` controls. Inspection may retrieve a sealed meta
row but MUST NOT acquire the account key, decrypt/interpret `bytes`, return
value bytes/list keys, or mutate any store. No exemption applies to a
session-bound read, owner-device read or pending update.

`run(scope, access, fn)` opens its own transaction over `scope.stores` plus
`gate`, `device`, `partitions`, `purgeIntents` and `quota`. The **first IDB
request** reads the gate. All following control reads verify the current
gate-HMAC and account-key records, incarnation, stamp, required browser
`keyId`/`accountKeyId`, precomputed `principalHash` and intents covering
`partitionId` / `identityKeyHash` **before any data request or `fn(tx)`**. A
stale stamp/key/principal is gated before checking an active deadline; an
active browser deadline is checked before signed/effective grant expiry.
The assert is internal to `run`, with no public `assert`. Browser callers
obtain a typed `ReplicaBrowserGateSnapshot` from
`ReplicaBrowserGateTx<IDBTransaction>.snapshot()`, then derive `principalHash`
and stored opaque ids asynchronously from `snapshot.gateHmac` **before** the
IDB transaction. Raw principal and WebCrypto promises never enter it.
`ReplicaBrowserGateTx` requires `ReplicaBrowserGateAccess` (including both
`keyId` and `accountKeyId`) at compile time; its snapshot cannot degrade to
the public-salt-only `ReplicaGateSnapshot`. Node callers precompute
`SaltedHash` principalHash before the guarded operation, then recheck the
gate's incarnation/salt/stamp under the profile lock or SQLite read transaction.

**Browser completion:** `readwrite` transactions use `{ durability: "strict" }`. `run` resolves only on the transaction's `oncomplete`; an abort or error rejects.

The assert refuses with `REPLICA_GATED`, aborts, and never runs `fn` when:
- the stamp's incarnation or epoch differs (`stamp_stale`);
- the gate's principal is null or another account (`principal_mismatch`);
- an intent covers `partitionId` or `identityKeyHash` (`purge_pending`);
- the gate can't be read (`gate_unavailable`).

**Node/CLI guarded operations:**
- **SQLite mutations** (page commit, `installGrant`, GC, repair) hold the profile lock across gate check and SQLite commit. **SQLite reads** take no profile lock; in one SQLite read transaction they check the gate (gate-file stat of mtime, size and inode; re-read on change) and the partition tombstone row. A read beginning before the tombstone commit linearises before deny.
- **Pending JSON is different:** it has no SQLite transaction or tombstone row. All pending reads and updates take the profile lock across the gate check and file access (§1). A store binds the current identity generation on its first successful guarded access. Deny atomically advances `pendingGenerations[identityKeyHash]` **with** the corresponding pending intent in the gate file. Erase then durably removes `pending.json` and the owner device record before clearing the intent by atomic gate-file rename. A missing file or generation starts at zero; stale bound stores reject `RESET_REQUIRED` after erase (unless a gate refusal takes precedence). Replay of an existing intent never increments the generation again. The intent blocks reads throughout, including after a crash. Fresh stores opened after activation bind the new generation; old stores cannot resurrect erased writes. There is no lock-free gate-check-then-file-read window.

**Gated results:** `open`, `get`, `list`, `status`, `grant()`, `installGrant`, `sync` and pending-store calls reject `REPLICA_GATED`. Nothing is read, created or written, and a sync's current page aborts with the epoch unchanged. `RESET_REQUIRED` is reserved for handles whose partition was **erased** after they opened.

**Controller behaviour when gated:**
- reads go to the network with `reason: "replica_gated"`;
- status is `gated` with a `gate` reason;
- sync errors carry `class: "lifecycle"`;
- there is no open backoff.

When the pending store is gated, the whole controller becomes `gated` for that stamp. Covered writes are then dispatched to the network **without** a pending record. Pending records only protect local serving, and none will happen. This differs deliberately from Phase 1's `STORAGE_ERROR` path, which refuses to dispatch. A session with no established stamp (for example B before activation) binds no controller.

### Delivery and stale replies

`checkDelivery(stamp): ReplicaDeliveryDecision` is the **synchronous, reason-bearing**
main-thread preflight before open, installGrant, get/list, sync or replica-derived events:
- `{ status: "allow" }` only for a current stamp and `now() < gate.consentDeadline`;
- `{ status: "consent_expired", code: "CONSENT_EXPIRED" }` when an active browser
  gate's deadline has elapsed, even if the signed UCAN expired earlier. For
  **already opened handles with known `replicaId`**, the controller records
  this transition once per active stamp/replica and emits `replication.grant`
  `consent_deadline_reached` code `CONSENT_EXPIRED`. It starts one scoped
  `deny({ reason: "consent_expired", principal })`, then dispatches network KV;
  no replica bytes or raw adapter exception reaches the read caller. A
  preflight before the first open has no opaque id and emits **no per-replica
  grant event**; scoped `replication.lifecycle`/recovery reports the denial;
- `{ status: "gated", gate }` when already denied/stale/missing (including when the timer
  won the race). Subsequent reads use network fallback `replica_gated` /
  `REPLICA_GATED`, normally `stamp_stale`.

An active controller's expiry timer uses `ReplicationScheduler` and the same
injected clock. It emits once only for **opened handles whose `replicaId` was
captured before key deletion**, de-duplicating a racing worker
`CONSENT_EXPIRED`. Startup recovery or preflight with no opened handle
instead reports `consentExpired: true` / lifecycle denial, never a synthetic
grant event. If the timer wins, an ensuing read is gated and need not see a
worker exception.

`deliverable(stamp)` is the synchronous **boolean reply fence** (`checkDelivery(stamp).status
=== "allow"`), with a required stamp. Browser checks localStorage marker/tombstone and the
in-memory gate deadline; node checks its process view. No stamp means not deliverable.
Worker replies carrying replica-served data are stamped (`ReplicaStampedReply`): deliver only
if `reply.stamp` deep-equals `handle.stamp` **and** `deliverable(reply.stamp)`. A reply without
a stamp is dropped. This includes get bytes, list keys and replica-derived divergence fields.

### Sign-out and account switch

1. **Deny.** `deny({ reason, principal, next? })` (`reason` includes `consent_expired`) flips
   this tab's or process's in-memory view **before its first await**, whatever the outcome.
   - If `principal` doesn't match the gate, the caller is stale. It disables itself in memory
     and the gate is untouched (`stale`).
   - Otherwise one commit:
     - clears the gate principal/hash on **every** scoped deny, including account switch, advances
       `lifecycleEpoch` (Node: past both the gate and its deny floor, § State) and records
       `deniedAt`; browser clears `consentDeadline`.
       `next` identifies the intended successor for sequencing only; it is never stored
       under the old HMAC key. A fresh authenticated B session establishes a new account
       key/principal only **after** old intents are erased.
     - records intents for every indexed partition and pending record of that principal; node
       advances each pending identity's generation in this **same gate-file write**;
     - clears its `first_install` anchors and browser
       `"grantInstall:" + identityKeyHash + ":" + accountHmac(cid)` anchors for each
       denied identity; no raw CID appears in the browser store key;
     - **Browser:** deletes account AES-GCM key(s), gate-HMAC key and owner device in the SAME
       IDB deny transaction, durably before any background erase; no key is re-created until
       a verified fresh establishment. The localStorage deny floor is written first, so stale
       tabs stop delivery before that IDB transaction.
     - **Node exception:** gate file and device record cannot commit atomically. Step 1 commits
       epoch, intents, pending generations and firstInstall clearing; the device record is
       durably deleted by the identity's pending-intent erase before intent clear. Replay is
       idempotent. Denial is immediate because every guarded operation checks the gate.

   Outcomes:
   - `denied`.
   - `stale`.
   - `deleted` (browser): the commit failed, and `deleteDatabase(REPLICA_KV_DATABASE)` succeeded. Every connection closes on `onversionchange`; a recreated database has a new incarnation and gate-HMAC key.
   - `marker` (browser): the delete failed or stayed blocked, and `REPLICA_LOGOUT_MARKER` was set. The marker blocks activation and delivery everywhere. Every load retries the delete, and the marker is cleared only once the delete succeeds.
   - `unguarded`: nothing could be written, so **cross-tab denial is not guaranteed**. This tab serves nothing. The docs state the limitation.
2. **Drain.** This tab's handles are cancelled and closed. Others are refused from their next transaction and nudged over the BroadcastChannel and the `storage` event.
3. **Erase.** `erasePending()` processes intents under the profile lock / browser erase transaction: `erasePartition` / `eraseIdentityPending`, `unindexPartition`, `accountErase` and `clearIntent`. Replay is idempotent: erasing a missing or tombstoned partition succeeds.
   - **Browser:** all of it is in one exempt transaction.
   - **Node partition order:**
     1. gate epoch bump + intent (step 1, atomic rename);
     2. a SQLite transaction that writes the partition tombstone and deletes rows;
     3. commit;
     4. unlink files;
     5. clear the intent (atomic rename).

     The partition erase must be durable before the intent clears.
   - **Node pending identity order:** intent and generation bump in step 1's atomic gate-file rename → unlink `pending.json` and owner `device.jwk` and sync the directory under the profile lock → clear intent durably. Replay sees the already advanced generation, retries deletion, and does not advance it twice. A missing file is success, never permission to read before intent clear.
   - **Node/CLI deferred revoke exception:** while `eraseDeferred` is true,
     `erasePending()` and `recover()` report outstanding intents but MUST NOT
     erase a partition, `pending.json` or `device.jwk`, or clear an intent.
     The full intent set and generation fences still block every guarded read,
     write and new establishment. Browser denial and erasure are unchanged.
   - **Browser local copy (`eraseLocalCopy`, step 3b):** after the deny, and once the replica runtime has closed its handles, the browser runs `eraseLocalCopy({ signal })` under the origin gate lock: it erases outstanding intents, then deletes the whole `REPLICA_KV_DATABASE` (never the `REPLICA_DENY_TOMBSTONE`). It deletes only when nothing live is at stake: the gate principal is null (denied), the gate epoch is behind the persisted tombstone (a commit that crashed after the tombstone), or `REPLICA_LOGOUT_MARKER` is set **with** a tombstone. A live or other-account gate, an unreadable tombstone, or a marker without a tombstone is `refused` and nothing is touched. A failed delete sets the marker (when a tombstone exists) so the next load's `recover()` finishes the erase and clears it, and returns `failed`. The node facade attempts it up to 3 times (retries after 150 ms, then 450 ms; 3 s per attempt); after the last failure it emits `replica.purge.failed` `{ trigger, reason, code, retryNow }`. `marker` leaves `signOut()` resolving; `unguarded` rejects with `REPLICA_PURGE_FAILED` unless the erase completed. `replication.purgeLocalCopy()` runs the same erase on demand and returns `{ ok: true }` or `{ ok: false, retryNow }` (`retryNow` is true for a `failed` erase, false for `refused`).
4. **Activate** (switch only). `activationAllowed(next)` requires a **non-null**
   gate principal hash computed under the **current** gate key matching `next`, no old
   intent and no marker. A null gate returns false; only `establishSessionStamp` on a
   **fresh authenticated session** can set it after the old purge and mint new keys.
   Until then, B's KV goes to the network. Old-key `nextHash` is never reused.

**`signOut` resolves** only after this tab's handles are cancelled and closed **and** step 1 has committed (or returned a fallback outcome). Node/CLI sign-out does not wait for erasure. **Browser** sign-out and account switch then erase the local copy (step 3b) before they resolve.

A transient `BUSY`, lock timeout or I/O failure **after committed denial**
does not resurrect replica reads; erase is resumable.

**Deny-first is normative for Node/CLI logout.** An explicit plain logout (and
a successful `logout --revoke`) first commits its durable fence (the complete
v1 gate denial, or the v2/v3 logout marker) and only then removes and fsyncs
**both** `session.json` (which may contain a private JWK) and `key.json`, then
retires the network session even while erase remains pending. A later sign-in
must rotate/re-establish its signer rather than reuse the deleted key. A
failure **before** that fence commits leaves both credential files on disk for
the retry and reports nonzero; the process retires its in-memory session and
keeps the replica gated in memory, and never claims durable completion. A
floor-lagging gate (§ State) is completed by that retry, not left blocking it.
This replaces clearing the session in a `finally` on every failure path, which
the CLI's `auth logout` no longer does.

**Logout by another account.** Only the gate's own active principal creates a
v1 marker for it or denies it; the facade never calls `deny` or erases a gate,
partition, pending state or device record whose active principal is not the
caller's. This state is reachable: an account B signing in to a profile in a
fresh process skips the account-switch deny, so the gate still holds account
A. When B (the session owner) logs out of a gate whose active principal is A:
1. no logout marker is written and A's gate, deny floor, partitions, pending
   state and device record are untouched;
2. under the profile lock the CLI durably writes `authSignedOut: true`
   (file and directory fsync), then unlinks and fsyncs **both** of B's
   credential files, `session.json` and `key.json`;
3. it erases the legacy v1 mirror (below), which belongs to the profile and
   its device grant rather than to any account.

In this path, preflight, the displayed listing, approval and
`--discard-local-changes` cover **only** the legacy mirror. A's roots,
partitions and pending state (even a nonempty `pending.json`) are never listed
for B, never block B's logout and never reach an erase callback; B never has
to approve A's files to sign out.

`--revoke` derives its CID set only from B's own session and the delegations B
is entitled to revoke, and revokes only those. It never includes A-issued
grants (such as A's device grants), which the node would refuse and so would
block B's `--revoke` forever. A's flag-owned replicas stay gated to A:
every guarded read and establishment checks A's salted principal hash, so B
(or any later account C) gets `principal_mismatch` and nothing of A's becomes
readable; leaving them in place is therefore safe, and A's own later logout
erases them. A floor-lagging gate with A's active principal is likewise never
completed by B: completion is refused, but B's credentials are still cleared.
A crash after step 2 is finished by startup (`authSignedOut` already forbids
restore); the legacy-mirror replay follows the rules below. The one accepted
exception to "never clear A's state" is an unreadable or corrupt gate: its
principal cannot be determined, so a logout with explicit discard consent takes
the v2 orphan path, which removes that gate and the approved flag-owned files
whoever owned them (TC-1313). Example: A signs in
with replication; in a fresh process the profile signs in as B, whose
replica establishment gets `principal_mismatch`. `tc auth logout` as B
removes B's `session.json` and `key.json` and the legacy mirror, writes no
marker, and leaves A's `replica-gate.json`, floor and partitions byte-for-byte
unchanged; no account but A can then read A's flag-owned replicas.
**Exception:** failed, partial, timed-out or interrupted `logout --revoke`
returns nonzero while retaining the network session, both key-bearing files
and physical replica files for retry. The v1 deferred gate denial or v2/v3
version-specific durable logout marker fences local reads. "Logout by another
account" needs no marker fence here: it erases nothing before its revokes
succeed and touches no state of A's, so a failed revoke simply leaves B's
credential files and the legacy mirror in place for the retry. This does not
reopen a TC-1208 sign-out path.

**Node/CLI `logout --revoke` deferred erase.** The node-sdk root export
`createProfileReplicaPurge({ profileDir, guard })` returns `ProfileReplicaPurge`
for `<profileDir>/replication`; `guard` is the mandatory profile lock and MUST
be reentrant within one async call chain, because the CLI calls the facade
while already holding its (reentrant) profile lock. This facade does not
extend the browser lifecycle interface.

Before **any** logout marker, deferred denial or remote revoke, the CLI calls
`preflightLogout({ principal, discardLocalChanges? })` under the profile lock.
The read-only `ProfileReplicaPreflight` reports `knownLegacyReplicas`,
`unknownLegacyPaths`, all `unknownPaths`, their JSON-safe `unknownEntries:
{ path, kind, dev, ino }[]`, and `knownRoots`, `knownEntries` and
`missingDatabases`. Paths are profile-relative; `dev` and `ino` are decimal
strings. The inventory covers both legacy and flag-owned replica files.
The CLI visibly lists **every** path/type/identity proposed for discard
before acting. Without explicit `--discard-local-changes`, unknown or
indeterminate data refuses before any marker, credentials, gate or remote
state changes. Explicit consent authorizes **only** that exact listed
inventory, not a wildcard for later additions.

**The legacy v1 mirror (`<profile>/replicas`) belongs to the profile and its
device grant, not to an account.** Its reads (`tc replica get/list`) check only
the logout marker, so it is not account-bound. **Every** logout of the profile
erases it, whichever account logs out (including "Logout by another account"
above), except `--keep-replicas` on a legacy-only profile, the documented
exception. The account loses only a cached copy that re-syncs from the network.
Without a logout marker, a replay after a crash erases only source-known
children; an unknown child is refused with a fresh listing, never deleted on a
prior command's consent.

The **legacy v1 mirror**, in v1, v2 or v3 profiles alike, recognizes only
the source-created SQLite layout: required `replica.db`, optional
`replica.db-wal`, `replica.db-shm` and `replica.db-journal`; optional
`blobs/.tmp/<64 lowercase hex>.<12 lowercase hex>` and
`blobs/<2 lowercase hex>/<matching 64 lowercase hex>`. A read-only
SQLite schema query must independently verify the exact source-created
v1 mirror schema or one of its two historical v2 mirror variants
(grant-install or policy columns); none has a pending/outbox table.
File names or a user-version number alone cannot prove that local writes
are absent.
Any other schema, extra file/directory, missing database, symlink
or unreadable/changing layout is unknown and refuses before marker/denial/
remote call absent explicit exact-inventory discard. The flag-owned
`fence.json` and its atomic temp name are recognized **only** for adapter
purge with `allowAdapterFence: true`, never for a legacy mirror. The
lease-fenced legacy `destroy` rechecks the approved identities,
unlinks only source-enumerated known files and explicitly approved unknown
entries, then removes empty directories; it never recursively removes a
tree or follows a symlink. A newly added/changed unknown path is not
authorized, including after a crash: stop and require a fresh visible list
and approval. The marker stores the approved inventory for that replay.

For `logout --revoke`, the CLI first calls
`prepareLogoutPending({ principal, approval, discardLocalChanges?,
remotePending: true })`. It re-inspects and compares the exact approved
path/type/dev/ino set under the profile lock, then fsyncs the inventory-bound
`remotePending` marker **before** any remote request. Pre-action mismatch
leaves all credentials and files intact with no marker or remote call.
The required pre-remote fence depends on the durable marker:

- **v1 active gate:** call
  `deny({ reason: "sign_out", principal }, { deferErase: true })` before
  online revoke. Any other reason with `deferErase: true` throws `TypeError`
  before mutation. Every deny outcome fences this process in memory before
  its first await; only a committed `denied` outcome carrying
  `resumeToken: { deniedEpoch, principalHash }` proves durable deferral.
- **v1 already deferred:** validate under the profile lock: matching
  incarnation; a **null** gate `principalHash`; `eraseDeferred` with
  `deferredPrincipalHash === marker.principalHash`; and a `deferredErase()`
  token with `token.principalHash === marker.principalHash` and
  `token.deniedEpoch === marker.deniedEpoch` (bound as below). Reuse that
  token; never deny again or substitute a marker with the denied epoch as
  its pre-denial epoch. A missing or mismatched original marker refuses.
- **v2 orphan:** validate the pinned, inventory-bound orphan marker and
  absence of a replacement gate. No gate salt exists to construct scoped
  intents, deny or produce a `resumeToken`; the fsynced marker and CLI read/
  restore fence are authoritative.
- **v3 inactive gate:** validate the marker's incarnation and exact current
  lifecycle epoch with null principal and no `eraseDeferred`. Do not deny
  again, invent a principal hash or require a `resumeToken`.

If the applicable fence cannot be committed or validated, the
`remotePending` marker remains; no remote request or credential/file cleanup
proceeds. Stale/unguarded v1 denial outcomes and a missing v1 token do not
authorize a retryable revoked session. A v2/v3 marker is not a v1 token.

**V1 denied-epoch binding.** A v1 marker's `lifecycleEpoch` is the pre-denial
epoch. The epoch its denial commits is never computed from it: a Node deny
advances past the deny floor, so an interrupted and then completed deny commits
at `lifecycleEpoch + 2` or later. Right after its v1 denial commits (deferred
for `--revoke`, ordinary in recovery), the facade atomically rewrites the marker
once with `deniedEpoch` set to the committed gate epoch, inside the **same
guard section** as that deny. A remote-pending marker binds only to a
**deferred** denial (`eraseDeferred`); a plain marker binds to an ordinary one.
Every later v1 check compares equality with `marker.deniedEpoch`, never
`lifecycleEpoch + 1`. If a
crash falls between the denial and that rewrite, the next locked validation
binds it once, and only when the incarnation matches, the gate principal is
null, the gate epoch is greater than `marker.lifecycleEpoch`, and, for a
deferred denial, both `deferredPrincipalHash` and the token principal equal
`marker.principalHash`. The CLI refuses establishment while any marker
exists, so no successor epoch can come between. A marker that already has
`deniedEpoch` is never rebound.

**Restored older gate.** If an older gate file is restored under a marker
that already has `deniedEpoch` (or a null-principal gate with `eraseDeferred`
is restored), completing it commits a new epoch that cannot equal the bound
one, so the check refuses on every retry. This fails closed with no in-place
exit. The CLI refuses with `REPLICA_GATED` and names the route: switch the
default profile first if needed (`tc profile switch <other>`), then
`tc profile delete <name>` and sign in again.

Example, an interrupted deny: the v1 marker records `lifecycleEpoch: 7`. The
logout's deny writes floor 8, then the process dies before the gate write, so
the gate (epoch 7, active principal) lags its floor. Re-running
`tc auth logout` completes the deny: floor 9, then gate 9 with a null
principal and the scoped intents. The marker binds `deniedEpoch: 9`; recovery
validates against 9, clears both credential files and erases. A
`lifecycleEpoch + 1` check would expect 8 and refuse forever.

For v1 only, the profile-locked, fsynced atomic gate-file replacement commits the denied
epoch/time, null principal, a **complete enumeration** of scoped opaque
partition and pending intents, the pending identity generations, cleared
first-install anchors, `eraseDeferred: true` and the original salted
`deferredPrincipalHash` together. Enumeration may legitimately find **zero**
files and produce zero intents; it may not be skipped as an empty-intent
shortcut when files exist. An old handle cannot read despite retained physical
files. `deferredErase()` returns the durable nonsecret fencing token after
restart, including the zero-intent case. `pendingPurge()` lists outstanding
intents, but `purgePending` is true whenever `eraseDeferred` is true **or**
intents remain. Deferred `recover()`/`erasePending()` do not erase and may
report `remaining: 0` when enumeration was empty; callers MUST inspect
`deferredErase()` and never infer completion from that count. Establish/restore
refuse while the marker or intents remain; `activationAllowed` additionally
requires a non-null current principal (§2). A plain `deny` from the now-null
principal is stale.

The CLI permits `--discard-local-changes --revoke`. Only after the
inventory-bound marker **and its version-specific pre-remote fence** are
durable does it attempt each exact-CID remote revoke.
`remotePendingLogout({ principal })` revalidates that same v1 denied
epoch/hash/null principal, v2 absence of a replacement gate, or v3 exact
inactive epoch/null principal; it returns false only when no pending remote
step exists and never authorizes replica delivery.
While `remotePending: true`,
`recoverLogoutPending` MUST NOT unlink credentials or erase files; ordinary
network restore and all replica reads remain fenced. A failed, partial,
timed-out or interrupted remote sequence returns nonzero and leaves
`session.json`, `key.json`, the network session, SQLite replicas,
`pending.json`, owner `device.jwk` and approved unknown files physically
present. An explicit revoke retry may use that retained session/key only
for the remaining authoritative exact-CID revokes; already-revoked CIDs
count as done. No local erase occurs until **all** remote revokes succeed.

Then `completeRemoteLogout({ principal })` revalidates the marker's
`principalDigest` and the same version-specific fence under the profile lock:
v1 `marker.deniedEpoch`, salted principal hash and null principal; v2 the orphan
marker and no replacement gate; v3 incarnation, exact inactive epoch, null
principal and no `eraseDeferred`. It durably removes `remotePending` only
after all authoritative remote revokes succeed. It transitions **only** a
`remotePending` marker: on a remote-abandoned or an already cleanup-ready
marker it refuses `REPLICA_GATED`/`gate_unavailable` without mutation. The CLI
calls it only right after its own revoke sequence; a crash after the
transition resumes through `recoverLogoutPending`, not another completion. This transition means
**online success**; an explicit plain logout instead uses
`abandonRemoteLogout` below and never claims a remote receipt. Only a
cleanup-ready marker permits `recoverLogoutPending` to shred credentials
and resume erasure. For a v1 deferred gate, a wrong/old/successor token in
`resumeDeferredErase(token, { signal })` throws `REPLICA_GATED`
(`stamp_stale`) and erases nothing. Clearing `eraseDeferred` is durable
**before** ordinary idempotent erasure: a crash before that write remains
deferred; a crash after it replays by `recover()`. The same v1 token repeats
safely only while the denied epoch/hash and null principal persist. A
successor establishment or later denial fences it. The token is not a
secret bearer credential; the profile lock and gate checks are authoritative.

**CLI-only durable logout fence.** For plain logout, before unlinking either
credential the CLI calls
`prepareLogoutPending({ principal, approval, discardLocalChanges? })`
under the profile lock; verified successful revoke already has its
cleanup-ready marker. The facade re-inspects **the exact approved inventory**
and atomically writes and fsyncs `<profile>/replica-logout-pending.json`.
With a readable active gate, the scoped v1 marker binds `{ v: 1,
incarnation, lifecycleEpoch, principalHash }`. Every v1/v2/v3 marker also
persists a domain-separated SHA-256 `principalDigest` (not secret or a
replacement for the profile lock), a fresh random 16-byte
`approvalSalt` as 32 lowercase hex characters, `approvedUnknown`,
`knownRoots`, `knownEntries`, `missingDatabases` and optional explicit
`discardLocalChanges: true`. `remotePending: true` and
`remoteAbandoned: true` are mutually exclusive; absence of discard means
no consent. The marker is a crash fence and exact inventory approval, not
an empty list of purge intents or proof of completed denial. A prior
complete gate denial also fences reads if marker preparation fails; without
either durable fence credential deletion cannot be reported as safe
completed logout.

**An existing marker is never rewritten by `prepareLogoutPending`.** When the
owner, version-specific fence, `remotePending` state and approved inventory
all match the current preflight, it returns the existing marker unchanged
(an idempotent retry); otherwise it refuses `REPLICA_GATED`/`gate_unavailable`
without mutation. Only these transitions rewrite a marker, each under the
profile lock: the one-time v1 `deniedEpoch` binding; `completeRemoteLogout`
(drops `remotePending`); `abandonRemoteLogout` and `approveChangedPlainLogout`
(`remotePending` becomes `remoteAbandoned`); and `reapproveLogoutPending`
(a new approved inventory on a cleanup-ready marker). A changed inventory
therefore always goes through the two-command token approval or a fresh
reapproval, never a silent rewrite.

The marker is CLI-only: generic node SQLite storage does not infer a CLI
session-file layout, while CLI-bound `sqliteReplicaStorage` receives its
`logoutPendingFile` path. Every CLI-bound guarded read, list, status,
pending-store operation and replica delivery, including already-open handles
and legacy v1 mirror reads under `<profile>/replicas` (the `tc replica`
commands), checks it before serving; even ungated `inspectStatus` refuses the marker.
CLI startup refuses network restore or a fresh sign-in while it exists. The
CLI's marker check runs inside the **same** profile-locked section as
`establishSessionStamp`, not before it: after a zero-intent ordinary deny the
gate itself admits a fresh establishment, so the marker is the only barrier
and must be atomic with it.
An active gate with a missing `session.json` **without** this marker is not
logout evidence: fresh sign-in can establish the gate before persisting its
network session. Never infer abandonment from that absence alone.

With a missing gate and flag-owned files, or a corrupt gate even when its
roots appear empty, scoped intents cannot be reconstructed without a
verified gate salt. The CLI uses a **distinct** v2 orphan marker
`{ v: 2, scope: "orphan_profile", nonce }` with fresh opaque nonce and
the same approved inventory fields, fsynced before credential unlink.
Before writing it, the facade validates both roots under the profile lock:
each must be a real directory inside only the selected profile; a symlink
or out-of-root path fails even with discard consent. Nonempty pending
state, unknown layout or indeterminate corrupt gate requires an actionable
sync-first refusal unless explicit `--discard-local-changes` is supplied
**before** marker creation. Consent binds only the displayed path/type/
dev/ino inventory; v2 never invents scoped intents, silently regenerates
a gate or deletes outside the selected profile. `--keep-replicas` still
rejects gated profiles and cannot override this boundary. This v2 path is the
accepted exception to "Logout by another account": a corrupt or missing gate
cannot name its principal, so with explicit discard consent the orphan cleanup
removes the approved flag-owned files whoever owned them (TC-1313).

Directly under `replication/`, CLI-bound storage and purge name the CLI's
exact diagnostics files (`events.jsonl` and its rotation `events.jsonl.1`).
With a readable gate, only those names, and only while `lstat` shows a regular
file, are known: the deny's partition scan skips them and logout erases them
with the other source-owned residue. A symlink or any other type at those
names stays unknown, a missing or corrupt gate keeps them indeterminate, and
generic storage names no diagnostics file.

For a flag-owned identity directory, only a validated `identity.json` and
a regular `pending.json` whose parsed records are empty certify that local
writes are absent. A missing/unreadable pending index, a replica database,
`device.jwk`, `pending-v2.json` or **any** extra/unknown child is
indeterminate and requires explicit discard consent; an empty old pending
index does not excuse another child. No nonempty legacy child has a
reviewed pending index. On Linux, destructive traversal uses only the
exact kernel `/proc/self/fd/<n>` pinned directory-descriptor path; an
arbitrary alias or closed descriptor fails closed. On non-Linux, where
Node lacks equivalent `openat`, preflight `lstat`s **every** named path
component and refuses symlinks, recording directory and enumerated
file `dev`/`ino`; cleanup re-`lstat`s the components, directory and file
identities immediately before **each** unlink. Any mismatch stops without
following a symlink or deleting the new child. Only the enumerated,
identity-matched files are unlinked, never a recursive tree; `rmdir` is
allowed only on an empty approved directory. A hostile same-user rename
in the narrow interval between final check and unlink remains an accepted
bounded race under the CLI profile-key/session threat model, **not** a
claim of equivalent Linux descriptor confinement.

A readable gate that is **already denied** (`principalHash: null`,
`eraseDeferred: false`) but still has intents or a legacy root uses
`{ v: 3, scope: "inactive_gate", incarnation, lifecycleEpoch }` plus the
common inventory fields. It binds the exact current epoch and null
principal without inventing a principal hash or re-denying the account.
A successor gate/epoch makes this marker stale before credential deletion.
For **legacy** children, v1/v2/v3 share the verified read-only v1 mirror
allowlist and schema check above; source-known children need no discard.
Any other legacy child is unknown and requires explicit listed-inventory
discard before v3 is written. Active flag-owned v2/v3 replica and pending
rules are unchanged: the pending index and its empty-state proof remain
mandatory. When the gate's active principal **is the logout principal**,
`prepareLogoutPending` always yields a v1 marker, even with no intents and no
replica roots: recovery then commits the denial (deny floor, then the gate
with a null principal) before clearing credentials, so a later different
account establishes on an inactive gate instead of meeting
`principal_mismatch`. When the active principal is **another account**, it
returns null and denies nothing ("Logout by another account", § Sign-out). It
otherwise returns null only when there is no active principal (no gate, or an
inactive gate) and neither intents nor replica roots; the no-marker recovery report still reads the durable
outstanding-intent count under the profile lock. An
unreadable or corrupt gate instead reports
`failed: [{ id: "logout", code: "gate_unavailable" }]` and conservative
nonzero `remaining`, with callbacks/credentials untouched: never
fabricate a successful zero.

A `null` marker is **not** completed logout: with no replica-owned work
pending, `recoverLogoutPending` does not call `clearCredentials`. The CLI
still commits `profile.json.authSignedOut: true` atomically with file and
directory fsync under the profile lock **before** unlinking and fsyncing
both credentials, for plain logout and verified successful revoke. At
startup `authSignedOut: true` itself forbids network restore or implicit
profile-key sign-in; the CLI finishes any interrupted credential unlink
and pinned legacy cleanup under the same lock before ordinary commands.
If the signed-out write fails, retire the in-memory session, report nonzero
and do not claim crash-safe completion or unlink credentials without
durable signed-out provenance.

At startup and after marker preparation, the CLI invokes
`recoverLogoutPending({ signal, clearCredentials, eraseLegacyReplicas })`
before ordinary network restore. `remotePending: true` is **not**
cleanup-ready: recovery returns failure/remaining with **no**
`clearCredentials`, legacy callback, intent replay or local erase.
After `completeRemoteLogout` or a cleanup-ready plain-logout marker,
recovery validates the marker (v1 incarnation/epoch/hash; v2 orphan scope
and absence of a replacement gate; v3 incarnation/exact epoch/null
principal). **Before `clearCredentials`**, an active-v1 gate is denied
under the profile lock with the complete scoped partition/pending intents
and generation fences committed durably together. If that denial fails,
recovery reports nonzero failure and retains the marker, both credentials
and all replica files; it does not call `clearCredentials` or erase. An
already-deferred v1 instead validates its exact denied epoch
(`marker.deniedEpoch`) and hash; v2/v3
keep their existing orphan/inactive fences without a new scoped denial.
Only after the applicable fence is durable does recovery await
`clearCredentials` under the profile lock. That CLI callback first
atomically writes and **file+directory fsyncs**
`profile.json.authSignedOut: true` (absent means false); only then does it
unlink and fsync **both** `session.json` and `key.json`. It throws on any
write, fsync or unlink failure. The facade independently verifies both
credentials absent and fsyncs the profile directory **before** erasing
replica files.

The facade re-inspects against durable `approvedUnknown`, `knownRoots`,
`knownEntries` and `missingDatabases`; only previously approved identities
may still be present on replay, except a source-known **regular**
`replica.db-wal`, `replica.db-shm` or `replica.db-journal` in a legacy or
flag-owned replica may be created or change inode during recovery if the
approved child-directory identity and original `replica.db` dev/ino still
match. This exception applies only to the recovery check, never the
pre-action approval or an unknown path, changed database or changed root;
the lease-fenced remover re-inspects under the profile lock and pins each
sidecar's **current** identity immediately before nonrecursive unlink.
For v1, a successful remote revoke already committed generation-fenced
denial and complete opaque partition/pending intents before any node call.
A plain logout, or a marker written just before an interrupted pre-remote
denial, may instead reach cleanup with the original gate still active;
the pre-credential denial above fences that state. After credential
shredding, v1 clears only an exact matching deferred denial if present
and replays the committed intents idempotently; it never first denies an
active gate here. V3 retains its already-denied epoch without inventing
principal/intents. V2 retains its orphan fence without inventing a scoped
gate or intents. All three pass
`eraseLegacyReplicas({ discardLocalChanges, approvedUnknown, knownRoots,
knownEntries, missingDatabases })` to the CLI after credential shredding
and their version-specific gate or orphan fence. This callback deletes only
the lease-fenced, identity-matched approved legacy inventory nonrecursively.
The CLI passes
only the `replicas`-namespace subset of those arrays to
`removeProfileReplicas`; the facade retains and validates the **full**
legacy-and-flag inventory. The facade then replays scoped flag-owned
intents, erases only approved flag-owned unknowns and source-known control
residue, verifies both roots absent and fsyncs before clearing the marker.
A crash before marker clear retries against the same durable inventory.

If a new/changed path is seen **before** marker/denial/remote call, all
files and credentials remain and no marker or remote request is made.
If a new/changed path appears **after verified full remote success**,
cleanup stops with remaining files, the durable marker and
`authSignedOut: true`; credentials remain shredded and MUST NOT be
resurrected. Return nonzero with an actionable "cleanup incomplete;
re-run to finish" outcome. The CLI lists the **fresh** inventory for
explicit approval; `reapproveLogoutPending({ principal, approval })`
validates the cleanup-ready marker under the profile lock and fsyncs
only the new exact path/type/dev/ino approval. It MUST reject
`remotePending: true`. Recovery then retries without repeating the
already-completed remote revokes. Missing files from an interrupted
approved erase are idempotent; new or changed identities are not.
Any lock, credential deletion, gate write, root erase or marker removal
failure returns `failed` or nonzero `remaining`; callers return nonzero.
A stale v1/v3 marker never deletes a successor's credentials; v2 refuses
a replacement gate.

`authSignedOut` is distinct from transient `replica-logout-pending.json` and
persists after that marker clears. Ordinary CLI commands and all
authority-returning session/key readers MUST NOT implicitly sign in with
the retained `profile.privateKey` or restore a session while it is true.
An explicitly supplied `--private-key` is a separate headless identity,
not a way to reuse the stored profile key or clear this flag. Only an
explicit `auth login` may clear it in a profile-locked durable commit of a
newly verified session/key; when replica consent is eligible, that commit
also persists its fresh immutable `replicaStamp`. Replica-stamp refusal gates
only the replica, never a network-valid explicit login (§1). The Node facade
deliberately does not parse CLI `ProfileConfig`; the
`clearCredentials` callback's durable signed-out postcondition is owned
and crash-tested by the CLI. If it fails, the logout marker stays and
network restore/replica delivery remain fenced.

**Explicit plain logout after pending or failed `--revoke`.** This is an
override, not online success, and it always goes through
`abandonRemoteLogout` (or, after an inventory change, the separate token
command below); a plain logout never re-runs deny-first marker preparation on
a remote-pending marker. Under the profile lock, with no remote call, a v1
remote-pending marker is classified by its gate and checked in **exactly one**
way:
- **deferred-denied** (null principal, `eraseDeferred`,
  `deferredPrincipalHash === marker.principalHash`): the "v1 already
  deferred" checks against `marker.deniedEpoch` (binding it first if a crash
  left it unbound);
- **active, denial never started** (gate `principalHash ===
  marker.principalHash`, `lifecycleEpoch === marker.lifecycleEpoch`, matching
  incarnation, not floor-lagging): abandon without denying; recovery's
  pre-credential ordinary denial then fences it, since the abandoned marker is
  no longer remote-pending;
- **floor-lagging with the marker's principal**: complete the interrupted deny
  first as a **deferred** deny (the marker is still remote-pending), bind
  `deniedEpoch`, then apply the deferred-denied check.

Any other gate state refuses without mutation. V2 checks its pinned orphan
marker and absence of a replacement gate; v3 checks its exact inactive epoch
and null principal. On the **first**
plain-logout command the CLI
obtains and displays a fresh read-only preflight, then calls
`abandonRemoteLogout({ principal, approval, discardLocalChanges? })`
under the profile lock. The facade compares the **original** durable
inventory X with the current inventory Y before considering the supplied
approval. If X differs from Y, it refuses `REPLICA_GATED/gate_unavailable`
with Y's paths/identities and an `inventoryApprovalToken`; it changes
neither marker nor credentials/files, even if this command supplied
`--discard-local-changes` and an approval for Y. It makes no node call.
There is no same-command auto-chain to approval. With X unchanged, it
validates the owner, fresh approval and marker's version-specific fence,
then atomically replaces `remotePending` with `remoteAbandoned: true`.

The displayed token is the first 16 bytes of SHA-256 in lowercase hex,
over UTF-8 `tc-logout-approve-v1\0` followed by the canonical JSON array
`[markerId, approvalSalt, principal, epoch, entries]`. `markerId` is
`[v, incarnation, lifecycleEpoch, principalDigest]` for v1/v3 and
`[v, nonce, principalDigest]` for v2; `epoch` is null for v2.
`approvalSalt` is the random persisted marker field. `entries` contains
the **full current** unknown and known entries `{path,kind,dev,ino}`,
known roots represented as `kind: "directory"`, and missing databases
represented as `{path,kind:"missing",dev:"",ino:""}`, sorted by JavaScript
UTF-16 code-unit ordinal comparison (`<`/`>`), not locale or UTF-8 byte
order, by path, kind, dev, then ino. For example, a path beginning U+10000
sorts **before** one beginning U+E000, although their UTF-8 byte order is
the reverse. The refusal's typed
`inventoryApprovalEntries: ProfileReplicaApprovalEntry[]` and message
display this same token-bound set from one locked preflight. Paths are
bound by the hash but are not encoded in the visible token. The token is
a nonsecret confirmation fence, not authority or a substitute for the
profile lock.

Only a **separate invocation** with both `--discard-local-changes` and
`--approve-inventory <token>` calls
`approveChangedPlainLogout({ principal, approval,
discardLocalChanges: true, inventoryApprovalToken })`. Under the lock it
rechecks the remote-pending marker, original-X-to-current-Y mismatch,
principal, the version-specific v1 active/deferred, v2 orphan or v3 inactive
gate fence, and the exact current preflight, then recomputes the token.
Missing, mismatched or reused tokens refuse without mutation and
show a fresh listing/token on inventory change. A match atomically
persists Y's approved inventory and `remoteAbandoned: true`, never a
remote receipt. No expiration is imposed on the token; an epoch, marker
or inventory change invalidates it. TTY and non-TTY use the same two
commands.

The cleanup-ready marker permits `recoverLogoutPending` to fsync
`authSignedOut`, shred both credentials and erase only approved inventory,
with zero further node requests. A crash before marker transition retains
credentials/files and the remote-pending retry fence; a crash after it
resumes plain cleanup, not remote revoke. Wrong owner or stale gate
refuses without erasure.

**Deferred intents stay gated until resumed, on every platform.** On
Node/CLI they leave the deferred state only through a validated
`resumeDeferredErase` after remote success, or through the explicit
plain-logout override above, whose recovery performs the same validated
resume. There is no account-switch or consent-expiry override on Node/CLI:
`consentDeadline()` is null on a Node gate, a deny from the now-null
principal is `stale`, and establishment (so any account switch) is refused
while the deferred marker or intents remain. The browser never defers erase,
so no override exists there either.

`auth logout --keep-replicas` is rejected **before** online work or mutation
with `INVALID_ARGUMENT` when a read-only inventory finds any gate, partition,
pending or flag-owned replication state, or cannot prove their absence. The
legacy-only no-gate case retains its existing behavior; `deferErase` is never
broadened to implement this flag. No browser gate path uses this exception.

**Implementation status (Node/CLI).** node-sdk implements the whole facade and
exports this contract's `ProfileReplicaPurge` and `ProfileReplicaDeferredToken`
unchanged (checked at compile time by `profile-purge.contract.ts`). Its
`createProfileReplicaPurge` documents the reentrant `guard`. `deny` is typed as
above: `deferErase: true` only with `reason: "sign_out"`, returning a deferred
`denied` outcome with a required `resumeToken`, and a pass held by a deferred
denial reports `ReplicaEraseReport.deferred: true`. The CLI logout is deny-first,
binds v1 `deniedEpoch` in the deny's guard section, completes a floor-lagging
gate, implements "Logout by another account" and the legacy-mirror rules, keeps
the logout-marker check on legacy mirror reads and inside the
`establishSessionStamp` section, and refuses a restored older gate with the
`tc profile delete` route. An interrupted legacy-mirror erase after another
account's logout is recorded as `profile.json.legacyReplicaCleanup: true` in the
same durable write as `authSignedOut`; startup replays it for source-known
children only. Node `inspectStatus` reports `purgePending` from `eraseDeferred`
or outstanding intents.

**Startup.** `recover()` runs before anything binds:
1. browser retries a pending database delete if the marker is set;
2. before any v1→v2 upgrade, under the origin gate Web Lock it probes the v1
   gate read-only, validates and preserves the maximum legacy denial epoch/time
   and localStorage tombstone (§ Appendix); an unreadable floor fails closed;
3. browser checks the durable consent deadline with the shared clock. If elapsed,
   it runs scoped `deny({ reason: "consent_expired", principal })` and durably
   deletes both encryption keys before any replica read/open, then schedules
   erase. `ReplicaEraseReport.consentExpired` is true only after that key-deletion
   commit; failures leave the gate closed;
4. CLI checks its durable logout marker **before** network restore or any
   replica binding and completes credential shred/gate conversion/replay as
   above. Otherwise every outstanding intent is erased, **except** Node/CLI
   intents held by a durable `eraseDeferred` revoke. Those remain fenced and
   physically intact until a validated resume (after remote success, or
   through the explicit plain-logout override); see above.

It never rejects; leftovers show as `purgePending`. A browser closed through the
deadline cannot delete keys while closed; the next load checks before serving.

**Clock seam.** `ReplicaClock = () => number` returns ms. Production defaults to `Date.now`.
S3's main-thread `createIndexedDbLifecycle({ now })` and `ReplicaGateTx` receive the
same test clock as S4's existing `ReplicationScheduler.now()` and S1's worker host
`createKvWorkerHost({ ...wasmWorkerDeps, now: () => clockMs })`. There is **no public**
`indexedDbReplicaStorage({ now })` option and no production function/closure crossing
postMessage. The test-only worker clock wire is exactly:
- main → worker `{ testOnly: "setClock", at: number }`;
- worker → main ACK `{ testOnly: "clockSet", at: number }`.

The fixture worker factory retains its worker; `advanceClock(at)` waits for the matching
ACK before reads. `WorkerConnection` ignores the id-less ACK. Main and worker use the
same injected millisecond value for establish, deny (`deniedAt` floor), first install,
grant install/serve, every guarded read and the active consent timer. Node's SIWE clock
is unchanged. A synthetic browser jump to +7d persists a future `deniedAt`; real-node
SIWE issued at the unchanged wall time cannot re-establish in that fixture. Never relax the
strict post-deny anchor check to make a test pass: test re-consent separately with real time
or a separately validated future signed SIWE if supported.

## 3. Grant duration and renewal

**Policy inputs.** `ReplicationOptions.grantTtlMs` defaults to `DEFAULT_GRANT_TTL_MS` (24 h). A value `≤ 0` or above `MAX_GRANT_TTL_MS` (7 d) is a `TypeError`.

With replication on, the controller **always** passes `KVReplicaSpec.grantPolicy = { grantTtlMs, consentAnchor }`, and adapters reject `open` without it.

**Consent anchor** (`ReplicationAuthority.consentAnchor()`), selected by the verified
session form, not an opportunistic fallback:
1. A full owner SIWE session requires independently verified signed `issuedAt`,
   **finite signed `expirationTime`** and an exact-full-space uncaveated KV
   get+sync witness (`siwe`). A missing/invalid input returns `null`; it does
   **not** fall through to a compact leaf or local receipt timestamp.
2. A compact-only session can use the **oldest independently verified
   owner-authorizing proof's** signed `iat` (`delegation_iat`), else that same
   proof's `nbf` (`delegation_nbf`); never a child leaf's timestamp. The current
   compact parser lacks ancestor proof bytes, so this path currently returns `null`.
3. Otherwise `null`. Storage may use persisted `first_install` only to bound
   grant expiry, never to establish a session stamp or repair consent.

**Anchor invariants:**
- `at` is finite ms. SIWE is parsed from the independently verified owner's signed message;
  delegation `iat`/`nbf` comes from the oldest independently verified owner-authorizing
  proof. A leaf signed by an arbitrary did:key with empty `prf` is not owner consent,
  even with finite `iat`/`nbf`. Leaf signature/CID/audience alone are insufficient:
  a delegate cannot refresh consent by minting a new child under an old owner grant.
- Owner SIWE needs a finite, parseable signed `expirationTime` **and** a verified
  signed `issuedAt`; expirationless/unparseable SIWE may remain valid for network
  use but yields `consentAnchor() === null` for replication: no new stamp, mint
  or renewal. Fresh interactive sign-in requests finite expiration by default
  when replication is enabled. Neither restore nor the controller constructor
  invents or repairs the missing anchor.
- A signed owner SIWE is usable only with an independently verified **full session proof**,
  not `verifySessionGrant` or an unverified SIWE string. The authority requires the
  verifier's `verifiedRecap` array to contain at least one **uncaveated KV get+sync**
  capability for a scope in the exact full `session.spaceId`; a short-name match from
  another wallet does not count. Node uses
  `wasmBindings.validatePersistedSession({ header, CID, spaceId, jwk, address, chainId,
  siwe, signature })` and its verified recap; browser applies the same owner-proof and
  capability-witness rule. This establishes consent provenance, **not** arbitrary prefix
  authority: `sessionGrant`/`plan` still check each requested prefix independently.
  No verified witness means `consentAnchor() === null` and network-only `not_established`.
- Second-based sources are converted ×1000 **exactly once**, at the authority.
- Every eligible anchor passes `clampConsentAnchor(anchor, now)` **at capture**. It
  clamps to ≤ now; a non-finite value gives `null`. Only an independently
  verified owner proof may try its signed `nbf` after absent/invalid `iat`;
  a malformed full SIWE never falls through to a compact or storage anchor.
- Renewals never re-anchor.
- `first_install` is keyed by identity. It survives partition reset, purge, revocation and
  reinstall, and is cleared **only by `deny`** (§2). An unreadable anchor **fails closed**:
  no serving and no mint. It is not an independent proof of a fresh sign-in; absent verified
  recency, `establishSessionStamp` refuses `not_established` and the session uses network KV.

**Current compact-session boundary.** Restored compact sessions persist only the leaf token
and parent CID(s), not the owner proof bytes. A leaf with `prf=[oldOwnerCid]` can be minted with
a fresh `nbf` from authority predating deny. Until an API supplies and independently verifies
the owner-authorizing proof and its finite signed issuance/`nbf`, `consentAnchor()` returns
`null` for compact sessions. They cannot establish a new stamp and use network KV; a matching
persisted stamp still restores via `restoreSessionStamp`. Tests must reject both a fresh child
under an old owner proof and a chain whose owner timestamp is unavailable.

**Consent deadline** = `anchor.at + CONSENT_WINDOW_MS` (7 d).
The browser gate persists this deadline once at fresh establishment; restore and
renewal do not extend it. `ReplicaLifecycleGate.consentDeadline(stamp)` synchronously
returns the finite cached **durable gate deadline** only for a matching active stamp,
or `null` when stale/denied/unavailable. S3 caches it after establish/restore without
I/O at each call. S4's controller schedules from this method immediately when the
session binds, including a restored compact session with `consentAnchor() === null`;
it never substitutes a grant-policy anchor or `first_install`. The callback rechecks
`checkDelivery(stamp)`, emits the deadline event for each already-opened opaque
`replicaId` once, and starts scoped `deny({ reason: "consent_expired", principal })`.
`null` omits this proactive timer, not the mandatory startup/open/read/preflight
checks. Node/CLI may return `null` when no deadline lives in their gate file.

A later **fresh interactive sign-in by the same principal** returns the same
session stamp and does **not** extend the existing durable gate deadline.
Its newly verified SIWE anchor may appear in `grantPolicy` without pretending
to be the older one: in the **browser** the controller calls
`mintRemainingMs` with `consentDeadline = min(consentDeadlineMs(policyAnchor),
lifecycle.consentDeadline(stamp))`, retaining the `grantTtlMs` duration cap.
The browser adapter passes that same **minimum deadline** into
`effectiveGrantExpiry` at install and recompute-at-open, and the gate separately
checks its persisted deadline before every read. A null/stale browser getter
refuses local mint and serving; neither a newer policy anchor nor `first_install`
extends the gate. Node/CLI with no persisted gate deadline derive the mint cap
from the once-clamped independently verified owner SIWE policy anchor (never a
compact leaf), and the adapter enforces the effective expiry using that anchor
and the node SIWE clock.

**Effective expiry:**

```
effectiveGrantExpiry({ signedExpiresAt, installedAt, grantTtlMs, consentDeadline })
  = min(signedExpiresAt ?? ∞, installedAt + grantTtlMs, consentDeadline)
```

`installedAt` comes from the storage clock at the **first** install of that grant CID. It is stored keyed by CID and set once: re-installing doesn't refresh it, and recompute-at-open uses the stored value. The adapter stores the effective expiry with the grant and **recomputes it at open** from the current policy, which caps grants restored from an older policy.

**Serve checks fail closed,** inside the read transaction:
- Browser gate checks its durable consent deadline **before** signed/effective grant expiry.
  At `!(now < consentDeadline)` (including non-finite/missing), the read
  transaction aborts without bytes or keys. The worker then awaits its
  main-thread scoped deny/key-shred RPC **after** the transaction settles and
  only then returns `CONSENT_EXPIRED`; failed denial fails closed
  (`REPLICA_GATED` `gate_unavailable`), never reports successful shredding.
  A shorter signed `exp` does not hide the 7-day event.
- Otherwise serving requires `now < effectiveExpiresAt`. A missing or non-finite stored
  bound refuses `GRANT_EXPIRED`. The controller falls through to a **network result** with
  `replication.read` reason `grant_expired`, code `CONSENT_EXPIRED` or `GRANT_EXPIRED`;
  it does not surface a raw adapter exception to the read caller.
- Browser expiry is **destructive**: account and gate keys are deleted before purge. Node/CLI
  expiry blocks reads but does not erase; its existing SIWE clock path is unchanged.

**Clock rollback is an accepted risk for Phase 2.** Production clocks use `Date.now()`. The
node-enforced signed `exp` still bounds network use.

**Every grant path:**

| Path | Rule |
| -- | -- |
| Fresh mint | `mint(deviceDid, prefix, signal, { expiryMs })`, where `expiryMs = mintRemainingMs(…) = min(grantTtlMs, consentDeadline − now)`. It is a **duration**, forwarded as `delegateTo(…, { expiry: expiryMs })`. No mint when it is `≤ 0` (`CONSENT_EXPIRED`) |
| Session grant reused directly | installed only if within policy. Otherwise it's replaced by a derived capped grant (`canRenew`), or its effective expiry is enforced locally (`capped`) |
| Compact delegated / `sessionOnly` | no plan, mint or silent renewal. A matching restored stamp and an independently verified installed grant for the same identity/device/prefix are **necessary but not sufficient** for local serving. Every get/list also requires the **current session's own** uncaveated get authority for the requested key/list prefix, independently of that stored device grant. If `sessionGrant(prefix)` refuses `NOT_COVERED`, `CAVEATED_AUTHORITY` or `SESSION_EXPIRING`, or cannot establish current coverage, use the network even while the stored grant is active. Otherwise the effective expiry and durable browser consent deadline still apply |
| Installed grant reused at open | only if its stored effective authority is `valid`, it covers the prefix, its `effectiveExpiresAt` is ahead and `now <` the applicable consent deadline |
| Restored from an older policy | recomputed at open; capped locally |

For a compact delegate with no independently installed matching grant, `replication.sync` rejects with `GRANT_MISSING`; `get`/`list` are network-only; no local bytes are returned and no grant is minted.

**Silent renewal.** `needsSilentRenewal(…)` is true when the remaining lifetime is **strictly** below `RENEW_BELOW_FRACTION × (effectiveExpiresAt − installedAt)` (exactly 25% remaining does not renew) and `now < consentDeadline`. It is false for non-finite inputs.
- It is checked on a timer, before each sync, and at open.
- `canRenew` is true **only** for independently verified owner session-key derivation via
  `delegateTo`, never for arbitrary/compact delegated authority or a wallet prompt.
- On refusal or offline, the current grant serves until its effective expiry.

**Events** (`replication.grant`, keyed by the opened handle's required opaque
`replicaId`): `minted`, `renewed`, `renewal_refused`, `renewal_deferred`,
`capped`, `expired` and `consent_deadline_reached` (`CONSENT_EXPIRED`).
An active controller emits the deadline transition **once per stamp and
opened replica**, whether main-thread preflight, worker refusal or timer
observes it first; later `stamp_stale` does not duplicate it. Before open,
no handle id exists, so no per-replica grant event is emitted and no raw or
unsalted prefix fallback is permitted. The scoped `replication.lifecycle`
`denied` event with `reason: "consent_expired"` (when runtime listeners
exist), plus `recover().consentExpired` on startup, observes expiry without
inventing a replica id.

**After the deadline:** browser keys are crypto-shredded, then content purged. No mint,
renewal or local read. Network reads continue. Re-consent requires a fresh verified
owner-backed anchor, new keys, fresh install and **full resync**; no old ciphertext is reused.
Node/CLI continue to block reads without automatic erase.

S4 implements `effectiveGrantExpiry`, `consentDeadlineMs`, `mintRemainingMs`, `needsSilentRenewal` and `clampConsentAnchor` in `grantPolicy.ts`.

## 4. Quota

**Options.**
- `maxBytes`: absent means unbounded.
- `minFreeBytes`: browser only, defaulting to `DEFAULT_MIN_FREE_BYTES` (64 MiB).

Both are forwarded as `KVReplicaSpec.quota`.

| | Browser | Node/CLI |
| -- | -- | -- |
| Budget scope | origin-wide **application-encoded rows** across `entries`, `blobs`, `meta` and replica-owned `device` records (not IDB disk allocation) | per profile (per storage `dir`) |
| Ledger | `quota` control store, in guarded page/device writes and exempt erase/deny transactions; partition and reserved device buckets are idempotent on replay | none: usage is derived from stored content, so erase replay is safe |
| Seam | shared `ReplicaQuotaLedger<IDBTransaction>`; S5's browser implementation extends it with combined `admitRows`/`accountRows` for partition+device signed deltas, without changing this public type | `ReplicaAdmitHook` (the `admit` option), run inside `applyPage`'s mutation under the profile lock |
| Free-space floor | `freeBytes()` (`navigator.storage.estimate()`), read just before the transaction | not applied |

**Browser persisted-row metric:** v2 `entries` rows use out-of-line key
`[opaquePid, accountHmac(path)]` and value
`{ pid, hashId?, v: 1, iv: Uint8Array, bytes: Uint8Array, size: number }`;
`blobs` rows use `[opaquePid, accountHmac(hash)]` and
`{ pid, v: 1, iv, bytes, size }`. An **active** `meta` row uses key
`opaquePid` and value `{ pid, revision, generation, coverageCode,
syncedThroughEpoch, keys, contentMissing, tombstones, contentBytes, purged:
false, v: 1, iv, bytes, size }`. A **purged** meta tombstone at that key is
keyless: `{ pid, revision, generation, coverageCode: 0, syncedThroughEpoch: 0,
keys: 0, contentMissing: 0, tombstones: 0, contentBytes: 0, purged: true,
size }`; it has **no** `v`, `iv` or `bytes`, and contains no sealed secret or
literal account/path data. All named controls except opaque `pid`,
`coverageCode: 0 | 1 | 2`, `purged: boolean` and active-row `v` are finite
numeric fields. `coverageCode` maps 0 = empty, 1 = bootstrapping, 2 =
complete. `revision`/`generation` support guarded CAS and stale-handle
`RESET_REQUIRED`; counts/epoch/`contentBytes` support redacted inspection.
Active config, grant, authority, cursor, error and lease
holder/token/serial/times are sealed in `bytes`, never exposed in controls.

`bytes` contains AES-GCM ciphertext (including its 16-byte tag). Plain
key/path/hash/content/config/grant/cursor/error values live **only inside**
sealed bytes; `hashId` is an opaque account-HMAC value. `size` is the exact
application-encoded persisted row metric, never plaintext length or an
arbitrary per-entry estimate. IDB engine/page/allocation overhead is
unobservable and excluded. `navigator.storage.estimate()` is approximate
and origin-wide: it supplies the separate free-space floor, not row usage.

`kv-storage/sealed.ts` defines `measureSealedRow(key: IDBValidKey, sealedRow)` (read-only
test export) as the **one** metric for active rows **and** keyless purged meta tombstones:
4-byte length + UTF-8 JSON encoding of the primary key; 2-byte object frame;
for every persisted field, 1-byte delimiter + UTF-8 field name; `pid` and
optional `hashId` each add 4-byte length + UTF-8 value; `v` (active rows only)
and `coverageCode` each add one byte; `purged` adds one byte; every other
numeric field (`revision`, `generation`, `syncedThroughEpoch`, `keys`,
`contentMissing`, `tombstones`, `contentBytes`, **and `size`**) adds a fixed
eight bytes; `iv` and `bytes` each add 4-byte length + raw bytes **only when
present**. Active-row `bytes` ciphertext includes its 16-byte AES-GCM
authentication tag. Fixed eight-byte `size` avoids recursive decimal-length
accounting. The same helper measures final presealed rows, old stored rows,
purged tombstones and GC/erase removals; it does not claim IDB filesystem bytes.

The same deterministic **application encoding** charges the final persisted
key+value envelope of the sealed owner-device record and the numeric
`firstInstall`/`grantInstall` device records, including ciphertext IV/tag and
all persisted key/field framing. These are not free merely because they are
outside `entries`/`blobs`/`meta`. S5 reserves
`DEVICE_QUOTA_PARTITION_ID = "device"` as a nonpartition ledger bucket; no
opaque partition id collides with it. Native serialization of nonextractable
`CryptoKey` records and IDB engine/page overhead cannot be measured per row
and remain excluded from this application metric.

Pre-seal new rows **outside** the transaction. In each guarded write
transaction check keyId/fence, read and measure old stored rows, compute a
single signed **net** `deltaBytes` from their `size` values and the final
presealed rows, then `admitPage(tx, { partitionId, deltaBytes, freeBytes })`
**before any put**. `STORAGE_BUDGET` aborts without page writes.
`accountCommit(tx, { partitionId, deltaBytes })` uses that **exact same**
number in the same transaction. This applies to page changes, replacements,
repair, GC and **every sealed meta mutation**, including lease/status writes;
none may bypass the ledger. Negative deltas release space and are not refused
solely because free space is below the floor. No WebCrypto await may keep the
IDB transaction open. The node `ReplicaAdmitHook` retains its blob-byte/entry
input semantics.

Device creation, grant-install and first-install writes measure old/new
**device** rows and combine their signed delta with any partition delta
before the first put. S5's browser-only `admitRows` and `accountRows` use the
**same** combined signed partition+device deltas in one guarded transaction,
enforcing the origin total plus free-space floor;
S1 MUST NOT count grant stamps in both partition `extraBytes` and the device
bucket. A standalone owner-device creation also admits before writing.
On deny, device rows (including owner and stamp records) are deleted and the
device bucket released **in that deny transaction** with key deletion; later
erase/replay cannot release them twice. Partition erase retains the
`accountErase` rule below. Node admission is unchanged.

Erase measures stored blobs, entries and active meta, writes the keyless
`purged: true` meta tombstone to fence open handles, then calls
`accountErase(tx, { partitionId, bytes })` with the **old total minus the
measured tombstone** in the same exempt transaction. The tombstone's `size`
remains charged to the partition bucket until it is physically deleted or
replaced; a same-pid reinitialisation admits the signed new-meta-minus-old-
tombstone delta. Once the partition index is gone replay releases zero and
never charges or subtracts the tombstone twice.

**Outcomes:**
- `STORAGE_BUDGET`: admission refuses the page or owner-device/stamp write before
  any mutation in that transaction. Owner-device setup fails closed to network
  read-through; no unbudgeted owner-device or grant-stamp row is persisted.
- `STORAGE_FULL`: the platform refuses it (`QuotaExceededError`, ENOSPC,
  `SQLITE_FULL`). Nothing from the attempted transaction commits or is counted.

Both stop an affected sync (`class: "storage"`) with the epoch unchanged.
Committed content serves while fresh. There is no eviction.

## 5. Options, status and events

- **Options:** `ReplicationOptions` adds `grantTtlMs?`, `maxBytes?` and `minFreeBytes?`. `ResolvedReplicationOptions.grantTtlMs` stays optional until S4 wires the default.
- **Status:** `persisted?`, `purgePending?` and `gate?`; `ReplicaInspectedStatus` is a discriminated redacted browser-only inspection branch; `ReplicaState` adds `gated`; `ReplicationReason` adds `replica_gated`.
- **Events:**
  - `replication.sync` adds `trigger: "peer"`, `origin?: "peer"` and `class: "lifecycle"`.
  - New `replication.grant` (§3).
  - New `replication.lifecycle`: `denied`, `deny_stale`, `deny_failed`, `database_deleted`, `marker_set`, `marker_cleared`, `unguarded`, `drained`, `erased`, `erase_failed`, `activation_blocked`, `activated` and `recovered`, with an optional `replicaId`, `reason`, `gate`, `partitions`, `remaining` and `code`.
- **Identifiers:** `replication.grant` and `replication.lifecycle` carry no **raw** account identifiers (`space`, prefix or principal), only `replicaId` (browser: private gate-HMAC partition id; node: replica hash). This is not a claim of browser-profile confidentiality or secrecy for existing event types. Existing `replication.read`, `write`, `sync`, `state` and `divergence` events still carry `space` and keys as a Phase 1 baseline limitation.
- **In-repo consumers updated:**
  - sdk-services `diagnostics.ts` allowlists;
  - `TelemetryEvents` (`REPLICATION_GRANT`, `REPLICATION_LIFECYCLE`);
  - the CLI `replication-log` debug output.

## Appendix: browser database layout

One IndexedDB database per origin, `REPLICA_KV_DATABASE` = `tinycloud-replica-kv`. All stores use out-of-line keys.

| Store (`REPLICA_KV_STORES`) | Owner | Key | Guarded by `run` |
| -- | -- | -- | -- |
| `meta` | adapter (S1) | private gate-HMAC `partitionId`; active v2 numeric/opaque inspection and CAS controls plus AES-sealed config/grants/authority/cursor/errors/lease, or keyless opaque/numeric `purged: true` tombstone with no `v`/`iv`/`bytes` (§4) | yes |
| `entries` | adapter | `[partitionId, accountHmac(path)]`; AES-sealed path, entry metadata and hash | yes |
| `blobs` | adapter | `[partitionId, accountHmac(hash)]`; AES-GCM ciphertext and sealed hash | yes |
| `pending` | adapter | private gate-HMAC `identityKeyHash`; AES-sealed identity, keys and pending state | yes |
| `device` | adapter/lifecycle | `"device"` (AES-sealed owner JWK); `"gateHmac"` and `"accountKey"` nonextractable key records; `"firstInstall:" + identityKeyHash` numeric ms; `"grantInstall:" + identityKeyHash + ":" + accountHmac(cid)` numeric ms. Sealed owner and timestamp rows charge the reserved device quota bucket; native CryptoKey bytes are unmeasurable | guarded data; deny exempt |
| `gate` | lifecycle (S3) | `"account"`: opaque hashes, finite consent deadline, epoch/incarnation/keyId | control |
| `partitions` | lifecycle | private `partitionId`, private principal/identity/lookup hashes, `ownerDevice` boolean; nonunique `byLookupId` secondary index | control |
| `purgeIntents` | lifecycle | private `ReplicaPurgeIntent.id` and stored opaque ids | control |
| `quota` | ledger (S5) | opaque partition id, reserved `DEVICE_QUOTA_PARTITION_ID = "device"` and numeric application-encoded byte accounting | control |

Active v2 `entries`, `blobs` and `meta` values have the sealed envelopes and
persisted `size` field specified in §4. A purged `meta` tombstone keeps only
opaque/numeric fence controls and its measured `size`, with no ciphertext or
key record; it stays charged in the partition ledger until replacement or
physical deletion. `kv-storage/sealed.ts:measureSealedRow` is the canonical
key-plus-row metric for active page/meta admission, keyless tombstones,
repair/GC and erase. The sealed owner-device and grant/first-install device
rows contribute their final key-plus-row application encoding to the reserved
device bucket; deny releases that bucket before background purge. No metric
claims unobservable IDB engine/page or native CryptoKey allocation.

**Destructive v1→v2 migration.** `REPLICA_KV_SCHEMA_VERSION = 2`. V1 contains
plaintext replica-owned rows incompatible with the sealed/HMAC v2 schema.
`create: false` opens with no requested version and returns `null` for v1,
without upgrading, reading plaintext or mutating it. Before **any** `create:
true` open under the origin gate Web Lock, lifecycle makes a versionless,
read-only probe of v1's gate and validates `lifecycleEpoch`/`deniedAt`. It
persists the component-wise maximum of that denial and the existing
`REPLICA_DENY_TOMBSTONE` into localStorage **before** dropping v1's gate; a
malformed/unreadable/unwritable floor fails closed with no activation. The
following `onupgradeneeded` versionchange **atomically deletes every v1
replica-owned data/control object store** and recreates all v2 stores (§ table),
including key records, pending state and quota. A blocked or aborted upgrade
is unavailable, never a v1 plaintext read/decrypt fallback or partial v2.
V1 stamps fail restore (new incarnation); only a new session with verified
owner consent later than the preserved deny floor may establish fresh keys
and full resync. No key is regenerated merely to read stranded v1 rows.
Old v1 connections close on `versionchange`; the worker, pending, inspection
and restore paths cannot request `create: true` ahead of lifecycle. The
low-level database opener is not a public bypass. The RC1 per-partition
databases (`tinycloud-replica/<id>`) remain untouched.

Migration acceptance scans every replica-owned v2 store **and secondary index
keys** (including `byLookupId`) for zero legacy plaintext rows, literal
prefixes/device DIDs/account IDs and no old key record, including after a
denied legacy gate.
The numeric localStorage denial tombstone survives and wins over pre-deny
SIWE on subsequent load; no migration success is inferred from an isolated
new BrowserContext.

Browser exact GET uses the account-HMAC path index. LIST scans the opaque partition rows,
decrypts sealed path/entry payloads outside the IDB transaction, then filters by prefix,
sorts, applies `after` and pages; a stamped reply still passes the main-thread delivery
check. Page changes are AES-GCM-sealed and indexed before opening the guarded commit
transaction, which atomically writes ciphertext and quota accounting. No WebCrypto await
may let that IDB transaction auto-commit.
