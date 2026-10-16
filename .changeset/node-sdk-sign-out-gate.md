---
"@tinycloud/node-sdk": patch
---

Stamp replica sessions only from a fully verified owner SIWE with finite signed expiry and exact-space KV get+sync authority; missing proof refuses only the replica, not network sign-in. Restore validates the persisted stamp without repairing it. Browser IndexedDB sign-in, restore, and sign-out use its lifecycle without a Node profile directory; sign-out denies the gate and shreds replica keys. Replication-disabled sign-in does not inspect replica SIWE metadata.

Node exports `createProfileReplicaPurge({ profileDir, guard })` for profile-locked CLI cleanup. A failed online revoke can durably deny local reads with `deny({ reason: "sign_out", principal }, { deferErase: true })` while retaining the network session, key, and replica files. The returned epoch/principal token resumes erasure after remote success; recovery leaves deferred files untouched and retries ordinary erasure after resume. `TinyCloudNode.signOut()` awaits durable denial before registry cleanup.

`TinyCloudNode.replicaStamp` exposes a defensive copy of the active verified stamp after sign-in or validated restore; sign-out clears it. `TinyCloudNode.signInWithOpenKey(authorizeFn, options?)` prepares the original SIWE before OpenKey approval and verifies the signed result through the existing authorization flow before committing the network session and replica stamp.
