---
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
---

Stamp replica sessions only from a fully verified owner SIWE with finite signed expiry and exact-space KV get+sync authority; missing proof refuses only the replica, not network sign-in. Restore validates the persisted stamp without repairing it. Browser IndexedDB sign-in, restore, and sign-out use its lifecycle without a Node profile directory; sign-out denies the gate and shreds replica keys. Replication-disabled sign-in does not inspect replica SIWE metadata.

Node exports `createProfileReplicaPurge({ profileDir, guard })` for profile-locked CLI cleanup. A failed online revoke can durably deny local reads with `deny({ reason: "sign_out", principal }, { deferErase: true })` while retaining the network session, key, and replica files. The returned epoch/principal token resumes erasure after remote success; recovery leaves deferred files untouched and retries ordinary erasure after resume. `TinyCloudNode.signOut()` awaits durable denial before registry cleanup.

`TinyCloudNode.replicaStamp` exposes a defensive copy of the active verified stamp after sign-in or validated restore; sign-out clears it. `TinyCloudNode.signInWithOpenKey(authorizeFn, options?)` prepares the original SIWE before OpenKey approval and verifies the signed result through the existing authorization flow before committing the network session and replica stamp. Optional `retryResult(error, originalRequest, attempt)` retries rejected callback transport or signed results against that same SIWE and key without retrying network activation.

Prefix-scoped, uncaveated signed KV get+sync authority now anchors replica consent as well as root authority. Node SQLite reads pair rows with a fence captured before their SQLite snapshot. A CID's original grant installation time survives targeted partition purge; an expired effective grant refuses synchronization before transport and refuses a page that expires before commit.
