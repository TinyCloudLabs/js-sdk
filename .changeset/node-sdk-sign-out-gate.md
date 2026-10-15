---
"@tinycloud/node-sdk": patch
---

Stamp replica sessions at sign-in, refuse replica restore without a valid gate stamp, and deny the replica gate on sign-out. Replication-disabled sign-in does not inspect replica SIWE metadata; a missing signed `Issued At` refuses only the replica stamp without synthesizing a wall-clock anchor or failing network sign-in.
