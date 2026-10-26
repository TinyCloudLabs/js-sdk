---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/replica": minor
---

Signing out erases the local copy before `signOut()` resolves: the browser replica database is deleted under the origin gate lock after the deny commit, and the same erase runs when a different account signs in on a live session. The deny floor and logout marker in `localStorage` are kept.

If the delete is blocked or the deny kept the keys (`marker`, `unguarded`), the erase is retried three times in total (150 ms, then 450 ms apart), the logout marker makes the next load finish it, and `signOut()` still resolves for `marker`. `unguarded` still rejects, now with `code: "REPLICA_PURGE_FAILED"` unless the erase completed. After the retries `replica.purge.failed` fires (`TinyCloudWeb.on` / `TinyCloudNode.on`) with `trigger`, a typed `reason` and `retryNow`.

`tcw.replication.purgeLocalCopy()` runs the erase on demand and returns `{ ok: true }` or `{ ok: false, retryNow }`; it never touches a live session. New exported types: `ReplicaPurgeFailedEvent`, `ReplicaPurgeLocalCopyResult`, `ReplicaPurgeTrigger`, `ReplicaLocalEraseOutcome`, `ReplicaPurgeError`. `ReplicaLifecycleGate` gains the optional browser method `eraseLocalCopy`.

A restore with replication configured and no wallet provider stays gated, now with the gate reason `wallet_provider_required` instead of `gate_unavailable`. A read-only provider (silent `eth_accounts`, signing methods that throw) still restores.

Details: TC-1888
