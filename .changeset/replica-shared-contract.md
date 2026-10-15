---
"@tinycloud/sdk-services": patch
"@tinycloud/cli": patch
---

Replication: add the shared replica contract for browser and node/CLI storage adapters: the lifecycle gate (`ReplicaGateTx.run`, session stamps, scoped deny), the grant-lifetime policy, the quota seams, the options `grantTtlMs`, `maxBytes` and `minFreeBytes`, and new status fields and events. It adds two subpaths, `@tinycloud/sdk-services/kv/replication/contractConstants` and `/grantPolicyTypes`. Diagnostics allowlists, `TelemetryEvents` and CLI debug output cover the new values.

Source-breaking for exhaustive consumers (replication is beta): switches over these types must now handle `ReplicaState` `gated`, `ReplicationReason` `replica_gated`, the `replication.grant` and `replication.lifecycle` events, sync `trigger: "peer"` and sync `class: "lifecycle"`. Browser ungated `inspectStatus` now returns a discriminated `ReplicaInspectedStatus { redacted: true }` branch without grant, authority or errors; consumers must narrow before reading those fields. Browser `admitPage` takes the exact signed ciphertext-row `deltaBytes` instead of plaintext `blobBytes`/entry count; node's admission hook retains its existing shape.

`ReplicaGateAccess` now carries a prederived `principalHash` instead of a raw principal; browser `run` requires gate/account key IDs and derives hashes outside IDB transactions. Browser partition-index entries add private-HMAC `lookupId` and nonsecret `ownerDevice` for owner status and scoped purge without decrypting the sealed owner device.

Phase 2 `ReplicaGatedHandle` requires the opaque `replicaId` supplied by the adapter. Consent-deadline grant events are emitted only for already opened handles with that id; pre-open expiry is reported by lifecycle/recovery, never a raw-prefix or unsalted identifier. `ReplicaLifecycleGate.consentDeadline(stamp)` exposes only the immutable persisted deadline to the main-thread timer, including compact session restore without a fresh anchor; it never derives one from first install.

The browser contract also defines the origin-wide deny tombstone outside the deletable IndexedDB database, its fail-closed gate semantics, and the lock requirement across lifecycle mutations.

Browser schema v2 destructively replaces legacy plaintext replica-owned v1 stores only after preserving the origin denial floor; pre-v2 persisted stamps cannot restore. The RC1 per-partition databases remain untouched.

Establishment takes `{ consentAnchor }`, not `{ siweIssuedAt }`: validated signed SIWE or an independently verified **owner-authorizing** delegation proof supplies finite recency, never a new child minted from old consent. With only a compact leaf or no owner proof timestamp, establishment refuses `not_established` and KV uses the network; matching persisted stamps may restore. Node `pending.json` operations require the profile lock across gate check and file access; deny records a durable identity generation with the pending intent. `activationAllowed` returns false for a null gate principal. Browser replica identifiers use private nonextractable gate-HMAC keys, and account KV metadata/content is sealed with separate account keys; denial or seven-day consent expiry shreds both key records before purge. This limits replica-owned storage plaintext but does not claim confidentiality against a raw browser-profile reader with a valid signed-in session (CONTRACT.md).

Replica consent from full SIWE requires verified signed `issuedAt`, finite signed `expirationTime` and an exact-space uncaveated KV get+sync witness. Expirationless or otherwise unanchored SIWE can remain network-valid but cannot establish, mint or renew a replica; refused stamps never fail network sign-in/restore, and restore never establishes. A same-principal fresh SIWE does not extend the persisted deadline: controller mint and adapter effective expiry are capped by the gate's durable deadline.

The browser origin-wide encoded-row budget includes a reserved device bucket for sealed owner-device and grant/first-install rows, admitted with partition rows before any put and released on deny. Native CryptoKey serialization and IndexedDB allocation remain unobservable; node admission is unchanged.

Compact `sessionOnly` restore with a matching stamp may serve an independently verified, already installed active grant scoped to the same identity/device/prefix until its effective expiry; it never mints or renews. Without a matching stamp and valid stored grant it remains network-only.
