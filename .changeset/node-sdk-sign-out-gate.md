---
"@tinycloud/node-sdk": patch
---

Stamp replica sessions only from a fully verified owner SIWE with finite signed expiry and exact-space KV get+sync authority; missing proof refuses only the replica, not network sign-in. Restore validates the persisted stamp without repairing it. Browser IndexedDB sign-in, restore, and sign-out use its lifecycle without a Node profile directory; sign-out denies the gate and shreds replica keys. Replication-disabled sign-in does not inspect replica SIWE metadata.
