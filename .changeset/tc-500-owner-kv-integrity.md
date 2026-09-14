---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
---

Reject addressed-share ciphertext whose exact owner-KV bytes do not match the
signed source digest before key unwrap or rendering. Revoke addressed shares
through the existing signed Policy/v3 root-revocation path, which cuts off
active sessions as well as fresh admission and delivery.
