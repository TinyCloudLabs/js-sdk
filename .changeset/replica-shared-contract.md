---
"@tinycloud/sdk-services": patch
"@tinycloud/cli": patch
---

Replication: add the shared replica contract for browser and node/CLI storage adapters: the lifecycle gate (`ReplicaGateTx.run`, session stamps, scoped deny), the grant-lifetime policy, the quota seams, the options `grantTtlMs`, `maxBytes` and `minFreeBytes`, and new status fields and events. It adds two subpaths, `@tinycloud/sdk-services/kv/replication/contractConstants` and `/grantPolicyTypes`. Diagnostics allowlists, `TelemetryEvents` and CLI debug output cover the new values.

Source-breaking for exhaustive consumers (replication is beta): switches over these types must now handle `ReplicaState` `gated`, `ReplicationReason` `replica_gated`, the `replication.grant` and `replication.lifecycle` events, sync `trigger: "peer"` and sync `class: "lifecycle"`. Browser ungated `inspectStatus` now returns a discriminated `ReplicaInspectedStatus { redacted: true }` branch without grant, authority or errors; consumers must narrow before reading those fields. Browser `admitPage` takes the exact signed ciphertext-row `deltaBytes` instead of plaintext `blobBytes`/entry count; node's admission hook retains its existing shape.

`ReplicaGateAccess` now carries a prederived `principalHash` instead of a raw principal; browser `run` requires gate/account key IDs and derives hashes outside IDB transactions. Browser partition-index entries add private-HMAC `lookupId` and nonsecret `ownerDevice` for owner status and scoped purge without decrypting the sealed owner device.

The browser contract also defines the origin-wide deny tombstone outside the deletable IndexedDB database, its fail-closed gate semantics, and the lock requirement across lifecycle mutations.

Browser schema v2 destructively replaces legacy plaintext replica-owned v1 stores only after preserving the origin denial floor; pre-v2 persisted stamps cannot restore. The RC1 per-partition databases remain untouched.

Establishment takes `{ consentAnchor }`, not `{ siweIssuedAt }`: validated signed SIWE or an independently verified **owner-authorizing** delegation proof supplies finite recency, never a new child minted from old consent. With only a compact leaf or no owner proof timestamp, establishment refuses `not_established` and KV uses the network; matching persisted stamps may restore. Node `pending.json` operations require the profile lock across gate check and file access; deny records a durable identity generation with the pending intent. `activationAllowed` returns false for a null gate principal. Browser replica identifiers use private nonextractable gate-HMAC keys, and account KV metadata/content is sealed with separate account keys; denial or seven-day consent expiry shreds both key records before purge. This limits replica-owned storage plaintext but does not claim confidentiality against a raw browser-profile reader with a valid signed-in session (CONTRACT.md).
