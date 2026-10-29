---
"@tinycloud/cli": patch
---

Temporarily refuse exact-email share publication with UNAVAILABLE (exit 4) before reading inputs or credential files or reaching publication services. Domain, DID and anyone targets, and notification of existing shares, keep their existing behavior. Do not fall back to a network-wide email policy when the node refuses path-bound registration.

Details: TC-2202
